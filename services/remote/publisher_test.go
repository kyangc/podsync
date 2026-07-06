package remote

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/request"
	"github.com/aws/aws-sdk-go/service/s3"
	"github.com/aws/aws-sdk-go/service/s3/s3iface"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mxpv/podsync/pkg/model"
)

func TestDetectMimeTypeResetsReader(t *testing.T) {
	reader := strings.NewReader("hello world")

	mimeType, err := DetectMimeType(reader)

	require.NoError(t, err)
	assert.NotEmpty(t, mimeType)
	pos, err := reader.Seek(0, io.SeekCurrent)
	require.NoError(t, err)
	assert.EqualValues(t, 0, pos)
}

func TestR2PublisherUploadPutsAndHeadsObject(t *testing.T) {
	api := newMockR2API()
	publisher := NewR2PublisherWithAPI(api, "bucket")
	body := []byte("audio bytes")
	task := &model.RemotePublishTask{
		R2Key:    "audio/feed/episode-token.mp3",
		Size:     int64(len(body)),
		MimeType: "audio/mpeg",
	}

	err := publisher.Upload(context.Background(), task, bytes.NewReader(body))

	require.NoError(t, err)
	assert.Equal(t, 1, api.putCount)
	assert.Equal(t, 1, api.headCount)
	got := api.objects[task.R2Key]
	assert.Equal(t, "bucket", got.bucket)
	assert.Equal(t, "audio/mpeg", got.contentType)
	assert.Equal(t, int64(len(body)), got.contentLength)
	assert.Equal(t, body, got.body)
}

func TestR2PublisherUploadRejectsSizeMismatch(t *testing.T) {
	headSize := int64(1)
	api := newMockR2API()
	api.headSize = &headSize
	publisher := NewR2PublisherWithAPI(api, "bucket")
	task := &model.RemotePublishTask{
		R2Key:    "audio/feed/episode-token.mp3",
		Size:     10,
		MimeType: "audio/mpeg",
	}

	err := publisher.Upload(context.Background(), task, bytes.NewReader([]byte("audio bytes")))

	require.Error(t, err)
	assert.Contains(t, err.Error(), "size mismatch")
}

func TestR2PublisherUploadRequiresKeyAndMimeType(t *testing.T) {
	tests := []struct {
		name string
		task *model.RemotePublishTask
	}{
		{
			name: "key",
			task: &model.RemotePublishTask{MimeType: "audio/mpeg"},
		},
		{
			name: "mime",
			task: &model.RemotePublishTask{R2Key: "audio/feed/episode-token.mp3"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			api := newMockR2API()
			publisher := NewR2PublisherWithAPI(api, "bucket")

			err := publisher.Upload(context.Background(), tt.task, bytes.NewReader([]byte("audio")))

			require.Error(t, err)
			assert.Equal(t, 0, api.putCount)
			assert.Equal(t, 0, api.headCount)
		})
	}
}

func TestNewR2PublisherRequiresConfig(t *testing.T) {
	tests := []R2Config{
		{},
		{Endpoint: "https://example.com", Bucket: "bucket", AccessKeyID: "key"},
		{Endpoint: "https://example.com", Bucket: "bucket", SecretAccessKey: "secret"},
	}

	for _, cfg := range tests {
		publisher, err := NewR2Publisher(cfg)

		require.Error(t, err)
		assert.Nil(t, publisher)
	}
}

type mockR2API struct {
	s3iface.S3API
	objects   map[string]mockR2Object
	failPut   bool
	headSize  *int64
	putCount  int
	headCount int
}

type mockR2Object struct {
	bucket        string
	body          []byte
	contentType   string
	contentLength int64
}

func newMockR2API() *mockR2API {
	return &mockR2API{objects: make(map[string]mockR2Object)}
}

func (m *mockR2API) PutObjectWithContext(_ aws.Context, input *s3.PutObjectInput, _ ...request.Option) (*s3.PutObjectOutput, error) {
	m.putCount++
	if m.failPut {
		return nil, errors.New("put failed")
	}
	body, err := io.ReadAll(input.Body)
	if err != nil {
		return nil, err
	}
	m.objects[aws.StringValue(input.Key)] = mockR2Object{
		bucket:        aws.StringValue(input.Bucket),
		body:          body,
		contentType:   aws.StringValue(input.ContentType),
		contentLength: aws.Int64Value(input.ContentLength),
	}
	return &s3.PutObjectOutput{}, nil
}

func (m *mockR2API) HeadObjectWithContext(_ aws.Context, input *s3.HeadObjectInput, _ ...request.Option) (*s3.HeadObjectOutput, error) {
	m.headCount++
	object, ok := m.objects[aws.StringValue(input.Key)]
	if !ok {
		return nil, errors.New("not found")
	}
	if m.headSize != nil {
		return &s3.HeadObjectOutput{ContentLength: m.headSize}, nil
	}
	return &s3.HeadObjectOutput{ContentLength: aws.Int64(int64(len(object.body)))}, nil
}
