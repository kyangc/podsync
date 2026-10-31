package diagnostics

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestHTTPObservesDecodeAndCloseWithoutRecordingSecrets(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"token":"PRIVATE",broken`)) }))
	defer server.Close()
	ctx, observation := StartHTTP(context.Background(), "remote_events", time.Second)
	var got Record
	observation.emit = func(v Record) { got = v }
	req, err := http.NewRequestWithContext(ctx, "GET", server.URL+"/PRIVATE?token=PRIVATE", nil)
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer PRIVATE")
	response, err := server.Client().Do(req)
	require.NoError(t, err)
	observation.Response(response)
	var payload any
	err = json.NewDecoder(response.Body).Decode(&payload)
	require.Error(t, err)
	require.NoError(t, response.Body.Close())
	observation.Finish(err)
	require.True(t, got.Failed)
	require.True(t, got.GotHeaders)
	require.True(t, got.WroteRequest)
	require.Equal(t, "body_read", got.Stage)
	require.Equal(t, "decode", got.ErrorKind)
	require.GreaterOrEqual(t, got.ReadMS, int64(0))
	require.Greater(t, got.BodyBytes, int64(0))
	encoded, _ := json.Marshal(got)
	require.NotContains(t, string(encoded), "PRIVATE")
	require.NotContains(t, string(encoded), server.URL)
}

func TestHTTPTimeoutPhaseAndLateConcurrentCallbacks(t *testing.T) {
	for _, phase := range []string{"connection_wait", "dns", "connect", "tls", "first_byte", "body_read"} {
		t.Run(phase, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			ctx, observation := StartHTTP(ctx, "remote_tombstones", time.Second)
			now := time.Unix(1000, 0)
			observation.started = now
			observation.now = func() time.Time { return now }
			trace := httptrace.ContextClientTrace(ctx)
			trace.GetConn("PRIVATE")
			switch phase {
			case "dns":
				trace.DNSStart(httptrace.DNSStartInfo{Host: "PRIVATE"})
			case "connect":
				trace.ConnectStart("PRIVATE", "PRIVATE")
			case "tls":
				trace.TLSHandshakeStart()
			case "first_byte":
				trace.GotConn(httptrace.GotConnInfo{Reused: true})
				trace.WroteRequest(httptrace.WroteRequestInfo{})
			case "body_read":
				trace.GotConn(httptrace.GotConnInfo{})
				trace.WroteRequest(httptrace.WroteRequestInfo{})
				trace.GotFirstResponseByte()
				observation.Response(&http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("PRIVATE"))})
			}
			now = now.Add(23 * time.Millisecond)
			cancel()
			var got []Record
			observation.emit = func(v Record) { got = append(got, v) }
			observation.Finish(context.Canceled)
			require.Len(t, got, 1)
			require.Equal(t, phase, got[0].Stage)
			require.Equal(t, "canceled", got[0].ContextState)
			require.Equal(t, int64(23), got[0].ElapsedMS)
			before := got[0]
			var wg sync.WaitGroup
			for i := 0; i < 20; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					trace.DNSDone(httptrace.DNSDoneInfo{})
					trace.ConnectDone("PRIVATE", "PRIVATE", errors.New("PRIVATE"))
					trace.TLSHandshakeDone(tls.ConnectionState{}, nil)
					trace.GotFirstResponseByte()
					observation.Finish(nil)
				}()
			}
			wg.Wait()
			require.Equal(t, []Record{before}, got)
		})
	}
}

type closeErrorBody struct{ io.Reader }

func (closeErrorBody) Close() error { return errors.New("PRIVATE") }
func TestHTTPCloseFailureRemainsDiagnosticOnly(t *testing.T) {
	_, h := StartHTTP(context.Background(), "remote_config", time.Second)
	var got Record
	h.emit = func(v Record) { got = v }
	response := &http.Response{StatusCode: 200, Body: closeErrorBody{strings.NewReader("ok")}}
	h.Response(response)
	_, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.Error(t, response.Body.Close())
	h.Finish(nil)
	require.True(t, got.CloseFailed)
	require.True(t, got.Failed)
}

func TestHTTPBodyReadFailurePreservesOriginalError(t *testing.T) {
	original := io.ErrUnexpectedEOF
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100")
		w.Write([]byte("x"))
	}))
	defer server.Close()
	ctx, h := StartHTTP(context.Background(), "remote_metadata", time.Second)
	var got Record
	h.emit = func(v Record) { got = v }
	req, _ := http.NewRequestWithContext(ctx, "GET", server.URL, nil)
	response, err := server.Client().Do(req)
	require.NoError(t, err)
	h.Response(response)
	_, err = io.ReadAll(response.Body)
	require.ErrorIs(t, err, original)
	response.Body.Close()
	h.Finish(err)
	require.Equal(t, "eof", got.ErrorKind)
	require.Equal(t, "body_read", got.Stage)
}

func TestOverlappingDialAndMultipleAcquisitionsAreExplicit(t *testing.T) {
	ctx, h := StartHTTP(context.Background(), "remote_episode", time.Second)
	now := time.Unix(2000, 0)
	h.started = now
	h.now = func() time.Time { return now }
	trace := httptrace.ContextClientTrace(ctx)
	trace.GetConn("PRIVATE")
	trace.ConnectStart("tcp", "PRIVATE1")
	now = now.Add(5 * time.Millisecond)
	trace.ConnectStart("tcp", "PRIVATE2")
	now = now.Add(7 * time.Millisecond)
	trace.ConnectDone("tcp", "PRIVATE1", nil)
	trace.TLSHandshakeStart()
	now = now.Add(3 * time.Millisecond)
	var got Record
	h.emit = func(v Record) { got = v }
	h.Finish(context.DeadlineExceeded)
	require.True(t, got.TraceAmbiguous)
	require.Equal(t, 1, got.PendingConnect)
	require.Equal(t, 1, got.PendingTLS)
	require.Equal(t, int64(15), got.ConnectMS)
	trace.ConnectDone("tcp", "PRIVATE2", nil)
	require.Equal(t, int64(15), got.ConnectMS)
	ctx, h = StartHTTP(context.Background(), "remote_config", time.Second)
	trace = httptrace.ContextClientTrace(ctx)
	h.emit = func(v Record) { got = v }
	trace.GetConn("PRIVATE1")
	trace.GotConn(httptrace.GotConnInfo{Reused: true})
	trace.WroteRequest(httptrace.WroteRequestInfo{})
	trace.GotFirstResponseByte()
	trace.GetConn("PRIVATE2")
	trace.GotConn(httptrace.GotConnInfo{Reused: true})
	h.Finish(nil)
	require.True(t, got.TraceAmbiguous)
	require.Equal(t, 2, got.Acquisitions)
}

func TestHTTPDeadlineDoesNotWaitForBlockedDiagnosticDisk(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	once := sync.Once{}
	recorder := newRecorder(func(Record) error { once.Do(func() { close(entered) }); <-release; return nil })
	recorder.Submit(sample())
	<-entered
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	ctx, h := StartHTTP(ctx, "remote_events", time.Second)
	h.emit = recorder.Submit
	request, _ := http.NewRequestWithContext(ctx, "GET", server.URL, nil)
	started := time.Now()
	response, err := server.Client().Do(request)
	if response != nil {
		response.Body.Close()
	}
	require.ErrorIs(t, err, context.DeadlineExceeded)
	h.Finish(err)
	require.Less(t, time.Since(started), 250*time.Millisecond)
	shutdown, stop := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer stop()
	recorder.Close(shutdown)
	close(release)
	select {
	case <-recorder.done:
	case <-time.After(time.Second):
		t.Fatal("worker did not terminate")
	}
}

func BenchmarkHTTPTrace(b *testing.B) {
	recorder := newRecorder(func(Record) error { return nil })
	defer recorder.Close(context.Background())
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		ctx, h := StartHTTP(context.Background(), "remote_events", 30*time.Second)
		h.emit = recorder.Submit
		trace := httptrace.ContextClientTrace(ctx)
		trace.GetConn("discarded")
		trace.GotConn(httptrace.GotConnInfo{Reused: true})
		trace.WroteRequest(httptrace.WroteRequestInfo{})
		trace.GotFirstResponseByte()
		response := &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("{}"))}
		h.Response(response)
		io.Copy(io.Discard, response.Body)
		response.Body.Close()
		h.Finish(nil)
	}
}
