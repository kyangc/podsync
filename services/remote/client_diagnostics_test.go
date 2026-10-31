package remote

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/mxpv/podsync/pkg/diagnostics"
	"github.com/mxpv/podsync/pkg/model"
	"github.com/stretchr/testify/require"
)

func TestNaturalEventCallRetainsDecodeFailureAfterHeaders(t *testing.T) {
	dir := t.TempDir()
	recorder, err := diagnostics.Open(dir)
	require.NoError(t, err)
	defer recorder.Close(context.Background())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("{PRIVATE")) }))
	defer server.Close()
	client, err := NewNASClient(server.URL, "PRIVATE", server.Client())
	require.NoError(t, err)
	_, err = client.PostEventBatch(context.Background(), &model.RemoteEventBatch{})
	require.Error(t, err)
	var syntax *json.SyntaxError
	require.True(t, errors.As(err, &syntax))
	recorder.Close(context.Background())
	files, err := filepath.Glob(filepath.Join(dir, "failure-*.jsonl"))
	require.NoError(t, err)
	require.Len(t, files, 1)
	data, err := os.ReadFile(files[0])
	require.NoError(t, err)
	require.NotContains(t, string(data), "PRIVATE")
	var record diagnostics.Record
	require.NoError(t, json.Unmarshal(data, &record))
	require.Equal(t, "remote_events", record.Operation)
	require.Equal(t, "body_read", record.Stage)
	require.True(t, record.Failed)
	require.Equal(t, 200, record.Status)
}
