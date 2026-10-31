package builder

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/mxpv/podsync/pkg/diagnostics"
	"github.com/stretchr/testify/require"
)

func TestDiscoveryProviderFailureIsNotMistakenForHTTPFailure(t *testing.T) {
	dir := t.TempDir()
	recorder, err := diagnostics.Open(dir)
	require.NoError(t, err)
	defer recorder.Close(context.Background())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"code":-352,"message":"PRIVATE"}`)) }))
	defer server.Close()
	client := newBilibiliAPIClient(server.Client(), server.URL)
	var result bilibiliAPIResponse
	require.NoError(t, client.get("/PRIVATE", url.Values{"mid": {"PRIVATE"}}, &result))
	require.Error(t, result.err())
	recorder.Close(context.Background())
	files, err := filepath.Glob(filepath.Join(dir, "failure-*.jsonl"))
	require.NoError(t, err)
	require.Len(t, files, 1)
	data, err := os.ReadFile(files[0])
	require.NoError(t, err)
	require.NotContains(t, string(data), "PRIVATE")
	var record diagnostics.Record
	require.NoError(t, json.Unmarshal(data, &record))
	require.Equal(t, "bilibili_discovery", record.Operation)
	require.Equal(t, -352, record.ProviderCode)
	require.Equal(t, "application", record.ErrorKind)
	require.Equal(t, 200, record.Status)
}
