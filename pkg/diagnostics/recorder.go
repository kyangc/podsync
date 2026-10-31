// Package diagnostics keeps bounded, identifier-free evidence from natural calls.
// It never participates in business retries, acknowledgement or admission.
package diagnostics

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	maxRecordBytes = 2048
	segmentBytes   = 1024 * 1024
	segmentRecords = 1024
	retention      = 7 * 24 * time.Hour
)

// Record contains no free-form text, addresses, identifiers, headers or payloads.
// Durations are milliseconds; -1 means that a phase was not observed.
type Record struct {
	AtNS              int64  `json:"at_ns"`
	StartedNS         int64  `json:"started_ns"`
	Operation         string `json:"operation"`
	Stage             string `json:"stage"`
	ErrorKind         string `json:"error_kind"`
	Failed            bool   `json:"failed"`
	ElapsedMS         int64  `json:"elapsed_ms"`
	BudgetMS          int64  `json:"budget_ms"`
	ClientLimitMS     int64  `json:"client_limit_ms"`
	ContextState      string `json:"context_state"`
	HTTPQueueMS       int64  `json:"connection_queue_ms"`
	AcquireMS         int64  `json:"connection_acquire_ms"`
	DNSMS             int64  `json:"dns_ms"`
	ConnectMS         int64  `json:"connect_ms"`
	TLSMS             int64  `json:"tls_ms"`
	WriteMS           int64  `json:"request_write_ms"`
	FirstByteMS       int64  `json:"first_byte_ms"`
	ReadMS            int64  `json:"body_read_ms"`
	Status            int    `json:"http_status"`
	ProviderCode      int    `json:"provider_code"`
	Reused            bool   `json:"connection_reused"`
	WroteRequest      bool   `json:"request_written"`
	GotHeaders        bool   `json:"response_headers"`
	ReadEOF           bool   `json:"body_eof"`
	CloseFailed       bool   `json:"body_close_failed"`
	BodyBytes         int64  `json:"body_bytes"`
	QueueMS           int64  `json:"downloader_queue_ms"`
	ExtractMS         int64  `json:"extract_offset_ms"`
	MediaMS           int64  `json:"media_offset_ms"`
	PostprocessMS     int64  `json:"postprocess_offset_ms"`
	NoDataBlocks      bool   `json:"no_data_blocks"`
	TraceAmbiguous    bool   `json:"trace_ambiguous"`
	PendingConnect    int    `json:"pending_connect"`
	PendingDNS        int    `json:"pending_dns"`
	PendingTLS        int    `json:"pending_tls"`
	Acquisitions      int    `json:"connection_acquisitions"`
	Dropped           uint64 `json:"dropped_before"`
	WriteFailures     uint64 `json:"write_failures_before"`
	Goroutines        int    `json:"goroutines"`
	ResourcesAtNS     int64  `json:"resources_at_ns"`
	AvailableKB       int64  `json:"memory_available_kb"`
	PressureSomeMilli int64  `json:"memory_pressure_some_milli"`
	PressureFullMilli int64  `json:"memory_pressure_full_milli"`
}

type Recorder struct {
	mu       sync.Mutex
	queue    chan Record
	done     chan struct{}
	closed   bool
	last     map[string]time.Time
	dropped  atomic.Uint64
	failures atomic.Uint64
	write    func(Record) error
}

var active atomic.Pointer[Recorder]

// Open starts one bounded worker. All file I/O stays off the request goroutine.
// Failures: at most 8 MiB / 8192 records; baselines: 2 MiB / 2048 records.
// Segments also rotate at UTC day boundaries, so recent failures never share
// an expiring old segment. Writes expire by first-record seven-day age, not mtime.
// Idle/stopped journals are pruned on the next write. Segment eviction may
// discard newer diagnostics too; it never touches business records.
func Open(dir string) (*Recorder, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("diagnostic directory must be a real directory")
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return nil, err
	}
	failure := journal{dir: dir, name: "failure", segments: 8}
	baseline := journal{dir: dir, name: "baseline", segments: 2}
	r := newRecorder(func(v Record) error {
		if v.Failed {
			return failure.append(v)
		}
		return baseline.append(v)
	})
	active.Store(r)
	return r, nil
}

func newRecorder(write func(Record) error) *Recorder {
	r := &Recorder{queue: make(chan Record, 64), done: make(chan struct{}), last: map[string]time.Time{}, write: write}
	go func() {
		defer close(r.done)
		for v := range r.queue {
			v.Dropped, v.WriteFailures = r.dropped.Load(), r.failures.Load()
			v.Goroutines = runtime.NumGoroutine()
			snapshotResources(&v)
			if r.write(v) != nil {
				r.failures.Add(1)
			}
		}
	}()
	return r
}

// Submit drops invalid records and overload; it never waits for disk or a slot.
func (r *Recorder) Submit(v Record) {
	if r == nil || !valid(&v) {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return
	}
	now := time.Unix(0, v.AtNS)
	if !v.Failed && now.Sub(r.last[v.Operation]) < time.Hour {
		return
	}
	select {
	case r.queue <- v:
		if !v.Failed {
			r.last[v.Operation] = now
		}
	default:
		r.dropped.Add(1)
	}
}

func Emit(v Record) { active.Load().Submit(v) }

// Close bounds shutdown waiting even if a diagnostic disk write is stalled.
// The sole worker has no subprocesses and exits with this process.
func (r *Recorder) Close(ctx context.Context) {
	if r == nil {
		return
	}
	active.CompareAndSwap(r, nil)
	r.mu.Lock()
	if !r.closed {
		r.closed = true
		close(r.queue)
	}
	r.mu.Unlock()
	select {
	case <-r.done:
	case <-ctx.Done():
	}
}

func valid(v *Record) bool {
	switch v.Operation {
	case "remote_config", "remote_events", "remote_episode", "remote_metadata", "remote_tombstones", "bilibili_discovery", "bilibili_download", "bilibili_playlist":
	default:
		return false
	}
	switch v.Stage {
	case "start", "connection_wait", "dns", "connect", "tls", "request_write", "first_byte", "response_headers", "body_read", "complete", "queued", "extract", "media", "postprocess", "open_output", "unknown":
	default:
		v.Stage = "unknown"
	}
	switch v.ErrorKind {
	case "none", "canceled", "deadline", "timeout", "dns", "tls", "eof", "transport", "http_status", "decode", "application", "process":
	default:
		v.ErrorKind = "application"
	}
	switch v.ContextState {
	case "none", "canceled", "deadline":
	default:
		v.ContextState = "none"
	}
	return true
}

type journal struct {
	dir, name string
	segments  int
	count     int
	loaded    bool
	now       func() time.Time
	day       int64
}

func (j *journal) path(i int) string {
	return filepath.Join(j.dir, fmt.Sprintf("%s-%d.jsonl", j.name, i))
}

func (j *journal) expired(path string) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	line, readErr := bufio.NewReader(io.LimitReader(f, maxRecordBytes)).ReadBytes('\n')
	closeErr := f.Close()
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return false, readErr
	}
	if closeErr != nil {
		return false, closeErr
	}
	if len(line) == 0 {
		return false, nil
	}
	var first struct {
		AtNS int64 `json:"at_ns"`
	}
	if json.Unmarshal(line, &first) != nil || first.AtNS <= 0 {
		return false, errors.New("invalid diagnostic segment")
	}
	now := time.Now()
	if j.now != nil {
		now = j.now()
	}
	if path == j.path(0) {
		j.day = first.AtNS / int64(24*time.Hour)
	}
	return now.Sub(time.Unix(0, first.AtNS)) > retention, nil
}

func (j *journal) append(v Record) error {
	data, err := json.Marshal(v)
	if err != nil || len(data)+1 > maxRecordBytes {
		return errors.New("diagnostic record limit")
	}
	data = append(data, '\n')
	for i := 0; i < j.segments; i++ {
		info, e := os.Lstat(j.path(i))
		if e != nil && !os.IsNotExist(e) {
			return e
		}
		if e == nil {
			if !info.Mode().IsRegular() || info.Size() > segmentBytes {
				return errors.New("unsafe diagnostic segment")
			}
			expired, e := j.expired(j.path(i))
			if e != nil {
				return e
			}
			if expired {
				if e = os.Remove(j.path(i)); e != nil {
					return e
				}
				if i == 0 {
					j.count = 0
				}
			}
		}
	}
	if !j.loaded {
		data, e := os.ReadFile(j.path(0)) // segment size was checked above
		if e != nil && !os.IsNotExist(e) {
			return e
		}
		j.count, j.loaded = bytes.Count(data, []byte{'\n'}), true
	}
	info, err := os.Stat(j.path(0))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if j.count >= segmentRecords || (info != nil && (info.Size()+int64(len(data)) > segmentBytes || j.day != v.AtNS/int64(24*time.Hour))) {
		if err := os.Remove(j.path(j.segments - 1)); err != nil && !os.IsNotExist(err) {
			return err
		}
		for i := j.segments - 2; i >= 0; i-- {
			if err := os.Rename(j.path(i), j.path(i+1)); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
		j.count = 0
	}
	f, err := os.OpenFile(j.path(0), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		j.count++
	}
	return err
}

// Linux proc snapshots are read only on the diagnostic worker, never the call.
func snapshotResources(v *Record) {
	v.ResourcesAtNS = time.Now().UnixNano()
	v.AvailableKB = -1
	v.PressureSomeMilli = -1
	v.PressureFullMilli = -1
	read := func(path string) string {
		f, err := os.Open(path)
		if err != nil {
			return ""
		}
		defer f.Close()
		b, _ := io.ReadAll(io.LimitReader(f, 8192))
		return string(b)
	}
	for _, line := range strings.Split(read("/proc/meminfo"), "\n") {
		parts := strings.Fields(line)
		if len(parts) >= 2 && parts[0] == "MemAvailable:" {
			if n, e := strconv.ParseInt(parts[1], 10, 64); e == nil {
				v.AvailableKB = n
			}
		}
	}
	for _, line := range strings.Split(read("/proc/pressure/memory"), "\n") {
		parts := strings.Fields(line)
		if len(parts) >= 2 {
			n, e := strconv.ParseFloat(strings.TrimPrefix(parts[1], "avg10="), 64)
			if e == nil {
				if parts[0] == "some" {
					v.PressureSomeMilli = int64(n * 1000)
				}
				if parts[0] == "full" {
					v.PressureFullMilli = int64(n * 1000)
				}
			}
		}
	}
}
