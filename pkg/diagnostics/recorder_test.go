package diagnostics

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func sample() Record {
	return Record{AtNS: time.Now().UnixNano(), Operation: "remote_events", Stage: "first_byte", ErrorKind: "deadline", Failed: true}
}
func TestBlockedSinkCannotDelayRequestsOrShutdown(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var writes atomic.Int64
	r := newRecorder(func(Record) error {
		if writes.Add(1) == 1 {
			close(entered)
		}
		<-release
		return errors.New("PRIVATE")
	})
	r.Submit(sample())
	<-entered
	start := time.Now()
	for i := 0; i < 1000; i++ {
		_, h := StartHTTP(context.Background(), "remote_events", time.Second)
		h.emit = r.Submit
		h.Finish(context.DeadlineExceeded)
	}
	require.Less(t, time.Since(start), time.Second)
	require.Greater(t, r.dropped.Load(), uint64(0))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	r.Close(ctx)
	require.Equal(t, ctx.Err(), context.DeadlineExceeded)
	close(release)
	select {
	case <-r.done:
	case <-time.After(time.Second):
		t.Fatal("diagnostic worker did not clean up")
	}
	require.Greater(t, r.failures.Load(), uint64(0))
}
func TestAllowlistAndSparseSuccess(t *testing.T) {
	records := make(chan Record, 10)
	r := newRecorder(func(v Record) error { records <- v; return nil })
	v := sample()
	v.Operation = "https://PRIVATE/?token=PRIVATE"
	r.Submit(v)
	v = sample()
	v.Stage = "PRIVATE"
	v.ErrorKind = "PRIVATE"
	v.ContextState = "PRIVATE"
	r.Submit(v)
	v.Failed = false
	r.Submit(v)
	r.Submit(v)
	v.AtNS += int64(time.Hour)
	r.Submit(v)
	r.Close(context.Background())
	require.Len(t, records, 3)
	for len(records) > 0 {
		v = <-records
		b, _ := json.Marshal(v)
		require.NotContains(t, string(b), "PRIVATE")
	}
}
func TestJournalCapacityRestartAgeAndPermissions(t *testing.T) {
	dir := t.TempDir()
	j := journal{dir: dir, name: "failure", segments: 2}
	for i := 0; i < 2*segmentRecords+3; i++ {
		require.NoError(t, j.append(sample()))
	}
	files, err := os.ReadDir(dir)
	require.NoError(t, err)
	require.Len(t, files, 2)
	total := 0
	for _, file := range files {
		p := filepath.Join(dir, file.Name())
		info, _ := os.Stat(p)
		require.LessOrEqual(t, info.Size(), int64(segmentBytes))
		require.Equal(t, os.FileMode(0600), info.Mode().Perm())
		b, _ := os.ReadFile(p)
		for _, c := range b {
			if c == '\n' {
				total++
			}
		}
	}
	require.Equal(t, segmentRecords+3, total)
	j = journal{dir: dir, name: "failure", segments: 2}
	require.NoError(t, j.append(sample()))
	require.Equal(t, 4, j.count)
	old := time.Now().Add(retention + time.Second)
	require.NoError(t, os.Chtimes(j.path(1), old, old))
	j.now = func() time.Time { return old }
	require.NoError(t, j.append(sample()))
	_, err = os.Stat(j.path(1))
	require.True(t, os.IsNotExist(err))
}
func TestDiagnosticSymlinkIsRejected(t *testing.T) {
	dir := t.TempDir()
	private := filepath.Join(dir, "private")
	require.NoError(t, os.WriteFile(private, []byte("PRIVATE"), 0600))
	j := journal{dir: dir, name: "failure", segments: 2}
	require.NoError(t, os.Symlink(private, j.path(0)))
	require.Error(t, j.append(sample()))
	data, _ := os.ReadFile(private)
	require.Equal(t, "PRIVATE", string(data))
}

func TestOldFirstRecordExpiresDespiteFreshSegmentMtime(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	j := journal{dir: dir, name: "failure", segments: 2, now: func() time.Time { return now }}
	old := sample()
	old.AtNS = now.Add(-retention + time.Hour).UnixNano()
	require.NoError(t, j.append(old))
	fresh := sample()
	fresh.AtNS = now.UnixNano()
	require.NoError(t, j.append(fresh))
	now = now.Add(2 * time.Hour)
	require.NoError(t, os.Chtimes(j.path(0), now, now))
	fresh.AtNS = now.UnixNano()
	require.NoError(t, j.append(fresh))
	data, err := os.ReadFile(j.path(0))
	require.NoError(t, err)
	require.Equal(t, 2, bytes.Count(data, []byte{'\n'}))
	require.Contains(t, string(data), fmt.Sprint(fresh.AtNS))
	require.NotContains(t, string(data), fmt.Sprint(old.AtNS))
}
