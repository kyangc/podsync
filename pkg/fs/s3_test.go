package fs

import (
	"bytes"
	"context"
	"io"
	"os"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/s3/transfermanager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
	"github.com/pkg/errors"
	"github.com/stretchr/testify/assert"
)

func TestS3_Create(t *testing.T) {
	files := make(map[string][]byte)
	stor, err := newMockS3(files, "")
	assert.NoError(t, err)

	written, err := stor.Create(testCtx, "1/test", bytes.NewBuffer([]byte{1, 5, 7, 8, 3}))
	assert.NoError(t, err)
	assert.EqualValues(t, 5, written)

	d, ok := files["1/test"]
	assert.True(t, ok)
	assert.EqualValues(t, 5, len(d))
}

func TestS3_Size(t *testing.T) {
	files := make(map[string][]byte)
	stor, err := newMockS3(files, "")
	assert.NoError(t, err)

	_, err = stor.Create(testCtx, "1/test", bytes.NewBuffer([]byte{1, 5, 7, 8, 3}))
	assert.NoError(t, err)

	sz, err := stor.Size(testCtx, "1/test")
	assert.NoError(t, err)
	assert.EqualValues(t, 5, sz)
}

func TestS3_NoSize(t *testing.T) {
	files := make(map[string][]byte)
	stor, err := newMockS3(files, "")
	assert.NoError(t, err)

	_, err = stor.Size(testCtx, "1/test")
	assert.True(t, os.IsNotExist(err))
}

func TestS3_Delete(t *testing.T) {
	files := make(map[string][]byte)
	stor, err := newMockS3(files, "")
	assert.NoError(t, err)

	_, err = stor.Create(testCtx, "1/test", bytes.NewBuffer([]byte{1, 5, 7, 8, 3}))
	assert.NoError(t, err)

	err = stor.Delete(testCtx, "1/test")
	assert.NoError(t, err)

	_, err = stor.Size(testCtx, "1/test")
	assert.True(t, errors.Is(err, os.ErrNotExist))

	_, ok := files["1/test"]
	assert.False(t, ok)

	err = stor.Delete(testCtx, "1/test")
	assert.True(t, errors.Is(err, os.ErrNotExist))
}

func TestS3_BuildKey(t *testing.T) {
	files := make(map[string][]byte)

	stor, _ := newMockS3(files, "")
	key := stor.buildKey("test-fn")
	assert.EqualValues(t, "test-fn", key)

	stor, _ = newMockS3(files, "mock-prefix")
	key = stor.buildKey("test-fn")
	assert.EqualValues(t, "mock-prefix/test-fn", key)
}

type mockS3API struct {
	files map[string][]byte
}

func newMockS3(files map[string][]byte, prefix string) (*S3, error) {
	api := &mockS3API{files: files}
	return &S3{
		api:      api,
		uploader: &mockS3Uploader{files: files},
		bucket:   "mock-bucket",
		prefix:   prefix,
	}, nil
}

type mockS3Uploader struct {
	files map[string][]byte
}

func (m *mockS3Uploader) UploadObject(_ context.Context, input *transfermanager.UploadObjectInput, _ ...func(*transfermanager.Options)) (*transfermanager.UploadObjectOutput, error) {
	content, _ := io.ReadAll(input.Body)
	m.files[*input.Key] = content
	return &transfermanager.UploadObjectOutput{}, nil
}

func (m *mockS3API) HeadObject(_ context.Context, input *s3.HeadObjectInput, _ ...func(*s3.Options)) (*s3.HeadObjectOutput, error) {
	if _, ok := m.files[*input.Key]; ok {
		return &s3.HeadObjectOutput{ContentLength: aws.Int64(int64(len(m.files[*input.Key])))}, nil
	}
	return nil, &smithy.GenericAPIError{Code: "NotFound"}
}

func (m *mockS3API) DeleteObject(_ context.Context, input *s3.DeleteObjectInput, _ ...func(*s3.Options)) (*s3.DeleteObjectOutput, error) {
	if _, ok := m.files[*input.Key]; ok {
		delete(m.files, *input.Key)
		return &s3.DeleteObjectOutput{}, nil
	}
	return nil, &smithy.GenericAPIError{Code: "NotFound"}
}
