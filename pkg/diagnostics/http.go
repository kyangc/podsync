package diagnostics

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"sync"
	"time"
)

// HTTP observes the existing transport without replacing proxies, pooling,
// HTTP/2, retries or deadlines. Hooks can run concurrently and after Finish.
type HTTP struct {
	mu       sync.Mutex
	done     bool
	started  time.Time
	now      func() time.Time
	ctx      context.Context
	record   Record
	phase    map[string]time.Time
	duration map[string]time.Duration
	inflight map[string]int
	readErr  error
	emit     func(Record)
}

func ClientTimeout(client any) time.Duration {
	if c, ok := client.(*http.Client); ok {
		return c.Timeout
	}
	return 0
}

func StartHTTP(ctx context.Context, operation string, clientTimeout time.Duration) (context.Context, *HTTP) {
	h := &HTTP{started: time.Now(), now: time.Now, ctx: ctx, phase: map[string]time.Time{}, duration: map[string]time.Duration{}, inflight: map[string]int{}, emit: Emit,
		record: Record{Operation: operation, Stage: "start", BudgetMS: -1, ClientLimitMS: clientTimeout.Milliseconds(),
			HTTPQueueMS: -1, AcquireMS: -1, DNSMS: -1, ConnectMS: -1, TLSMS: -1, WriteMS: -1, FirstByteMS: -1, ReadMS: -1}}
	h.record.StartedNS = h.started.UnixNano()
	if deadline, ok := ctx.Deadline(); ok {
		h.record.BudgetMS = max(0, deadline.Sub(h.started).Milliseconds())
	}
	trace := &httptrace.ClientTrace{
		GetConn: func(string) { h.begin("acquire", "connection_wait"); h.begin("queue", "connection_wait") },
		GotConn: func(v httptrace.GotConnInfo) {
			h.change(func() {
				h.end("acquire")
				h.end("queue")
				h.start("write", "request_write")
				h.record.Reused = v.Reused
				h.record.Stage = "request_write"
			})
		},
		DNSStart:          func(httptrace.DNSStartInfo) { h.begin("dns", "dns") },
		DNSDone:           func(httptrace.DNSDoneInfo) { h.change(func() { h.end("dns") }) },
		ConnectStart:      func(string, string) { h.begin("connect", "connect") },
		ConnectDone:       func(string, string, error) { h.change(func() { h.end("connect") }) },
		TLSHandshakeStart: func() { h.begin("tls", "tls") },
		TLSHandshakeDone:  func(tls.ConnectionState, error) { h.change(func() { h.end("tls") }) },
		WroteRequest: func(v httptrace.WroteRequestInfo) {
			h.change(func() {
				h.end("write")
				if v.Err == nil {
					h.record.WroteRequest = true
					h.start("first_byte", "first_byte")
					if !h.record.GotHeaders {
						h.record.Stage = "first_byte"
					}
				}
			})
		},
		GotFirstResponseByte: func() { h.change(func() { h.end("first_byte"); h.record.Stage = "response_headers" }) },
	}
	return httptrace.WithClientTrace(ctx, trace), h
}

func (h *HTTP) change(f func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.done {
		f()
	}
}

func (h *HTTP) begin(name, stage string) {
	h.change(func() {
		if name == "dns" || name == "connect" || name == "tls" {
			h.end("queue")
		}
		h.start(name, stage)
	})
}

func (h *HTTP) start(name, stage string) {
	if h.inflight[name] > 0 {
		h.record.TraceAmbiguous = true
	} else {
		h.phase[name] = h.now()
	}
	h.inflight[name] = min(64, h.inflight[name]+1)
	if name == "acquire" {
		h.record.Acquisitions++
		if h.record.Acquisitions > 1 {
			h.record.TraceAmbiguous = true
		}
	}
	h.record.Stage = stage
}

func (h *HTTP) end(name string) {
	if h.inflight[name] > 1 {
		h.inflight[name]--
		return
	}
	h.inflight[name] = 0
	if at, ok := h.phase[name]; ok {
		h.duration[name] += h.now().Sub(at)
		delete(h.phase, name)
	}
}

// Response keeps observing through reads and Close, including Decode failures.
// The caller's existing Close and returned business error retain their meaning.
func (h *HTTP) Response(response *http.Response) {
	if response == nil {
		return
	}
	h.change(func() {
		h.record.Status, h.record.GotHeaders = response.StatusCode, true
		h.record.Stage = "body_read"
		h.start("read", "body_read")
	})
	if response.Body != nil {
		response.Body = &observedBody{ReadCloser: response.Body, trace: h}
	}
}

type observedBody struct {
	io.ReadCloser
	trace *HTTP
}

func (b *observedBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.trace.change(func() {
		b.trace.record.BodyBytes += int64(n)
		if errors.Is(err, io.EOF) {
			b.trace.record.ReadEOF = true
		} else if err != nil {
			b.trace.readErr = err
		}
	})
	return n, err
}

func (b *observedBody) Close() error {
	err := b.ReadCloser.Close()
	b.trace.change(func() {
		b.trace.end("read")
		b.trace.record.CloseFailed = b.trace.record.CloseFailed || err != nil
	})
	return err
}

// ProviderResult records only the numeric Bilibili API code, never its body.
func (h *HTTP) ProviderResult(code int) { h.change(func() { h.record.ProviderCode = code }) }

func (h *HTTP) Finish(err error) {
	h.mu.Lock()
	if h.done {
		h.mu.Unlock()
		return
	}
	h.record.PendingConnect = h.inflight["connect"]
	h.record.PendingDNS = h.inflight["dns"]
	h.record.PendingTLS = h.inflight["tls"]
	for phase := range h.phase {
		h.inflight[phase] = 1
		h.end(phase)
	}
	value := h.record
	value.AtNS = h.now().UnixNano()
	value.ContextState = ErrorKind(h.ctx.Err())
	value.ElapsedMS = h.now().Sub(h.started).Milliseconds()
	for name, target := range map[string]*int64{"queue": &value.HTTPQueueMS, "acquire": &value.AcquireMS, "dns": &value.DNSMS, "connect": &value.ConnectMS, "tls": &value.TLSMS, "write": &value.WriteMS, "first_byte": &value.FirstByteMS, "read": &value.ReadMS} {
		if duration, ok := h.duration[name]; ok {
			*target = duration.Milliseconds()
		}
	}
	if err == nil {
		err = h.readErr
	}
	value.Failed = err != nil || value.CloseFailed || value.Status >= 400 || value.ProviderCode != 0
	value.ErrorKind = ErrorKind(err)
	if value.Failed && value.ErrorKind == "none" {
		value.ErrorKind = "transport"
		if value.ProviderCode != 0 {
			value.ErrorKind = "application"
		}
		if value.Status >= 400 {
			value.ErrorKind = "http_status"
		}
	}
	if value.Status >= 400 && value.ErrorKind == "application" {
		value.ErrorKind = "http_status"
	}
	if !value.Failed {
		value.Stage = "complete"
	}
	h.done = true
	h.mu.Unlock()
	h.emit(value)
}

// ErrorKind inspects types only: error text may contain URLs or credentials.
func ErrorKind(err error) string {
	if err == nil {
		return "none"
	}
	switch {
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline"
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return "eof"
	}
	var dns *net.DNSError
	var syntax *json.SyntaxError
	var unmarshal *json.UnmarshalTypeError
	var network net.Error
	var tlsHeader tls.RecordHeaderError
	switch {
	case errors.As(err, &dns):
		return "dns"
	case errors.As(err, &syntax), errors.As(err, &unmarshal):
		return "decode"
	case errors.As(err, &tlsHeader):
		return "tls"
	case errors.As(err, &network):
		if network.Timeout() {
			return "timeout"
		}
		return "transport"
	default:
		return "application"
	}
}
