package fs

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"path"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/feature/s3/transfermanager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
	"github.com/aws/smithy-go/logging"
	"github.com/gabriel-vasile/mimetype"
	"github.com/pkg/errors"
	log "github.com/sirupsen/logrus"
)

// S3Config is the configuration for a S3-compatible storage provider
type S3Config struct {
	// S3 Bucket to store files
	Bucket string `toml:"bucket"`
	// Region of the S3 service
	Region string `toml:"region"`
	// EndpointURL is an HTTP endpoint of the S3 API
	EndpointURL string `toml:"endpoint_url"`
	// Prefix is a prefix (subfolder) to use to build key names
	Prefix string `toml:"prefix"`
}

// S3 implements file storage for S3-compatible providers.
type S3 struct {
	api      s3API
	uploader s3Uploader
	bucket   string
	prefix   string
}

type s3API interface {
	DeleteObject(context.Context, *s3.DeleteObjectInput, ...func(*s3.Options)) (*s3.DeleteObjectOutput, error)
	HeadObject(context.Context, *s3.HeadObjectInput, ...func(*s3.Options)) (*s3.HeadObjectOutput, error)
}

type s3Uploader interface {
	UploadObject(context.Context, *transfermanager.UploadObjectInput, ...func(*transfermanager.Options)) (*transfermanager.UploadObjectOutput, error)
}

func NewS3(c S3Config) (*S3, error) {
	options := []func(*config.LoadOptions) error{
		config.WithRegion(c.Region),
		config.WithLogger(s3logger{}),
		config.WithClientLogMode(aws.LogRetries | aws.LogRequest | aws.LogResponse),
	}
	if c.EndpointURL != "" {
		options = append(options, config.WithBaseEndpoint(c.EndpointURL))
	}
	cfg, err := config.LoadDefaultConfig(context.Background(), options...)
	if err != nil {
		return nil, errors.Wrap(err, "failed to initialize S3 configuration")
	}
	client := s3.NewFromConfig(cfg)
	return &S3{
		api:      client,
		uploader: transfermanager.New(client),
		bucket:   c.Bucket,
		prefix:   c.Prefix,
	}, nil
}

func (s *S3) Open(_name string) (http.File, error) {
	return nil, errors.New("serving files from S3 is not supported")
}

func (s *S3) Delete(ctx context.Context, name string) error {
	key := s.buildKey(name)
	_, err := s.api.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: &s.bucket,
		Key:    &key,
	})
	if isS3NotFound(err) {
		return os.ErrNotExist
	}
	return err
}

func (s *S3) Create(ctx context.Context, name string, reader io.Reader) (int64, error) {
	key := s.buildKey(name)
	logger := log.WithField("key", key)

	// Detect MIME type from the first 512 bytes and then replay them with the rest of the stream.
	buf := make([]byte, 512)
	n, err := io.ReadFull(reader, buf)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return 0, errors.Wrap(err, "failed to read file header for MIME detection")
	}
	head := buf[:n]
	m := mimetype.Detect(head)
	body := io.MultiReader(bytes.NewReader(head), reader)

	logger.Infof("uploading file to %s", s.bucket)
	r := &readerWithN{Reader: body}
	_, err = s.uploader.UploadObject(ctx, &transfermanager.UploadObjectInput{
		Body:        r,
		Bucket:      &s.bucket,
		ContentType: aws.String(m.String()),
		Key:         &key,
	})
	if err != nil {
		return 0, errors.Wrap(err, "failed to upload file")
	}

	logger.Debugf("written %d bytes", r.n)
	return int64(r.n), nil
}

func (s *S3) Size(ctx context.Context, name string) (int64, error) {
	key := s.buildKey(name)
	logger := log.WithField("key", key)

	logger.Debugf("getting file size from %s", s.bucket)
	resp, err := s.api.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: &s.bucket,
		Key:    &key,
	})
	if err != nil {
		if isS3NotFound(err) {
			return 0, os.ErrNotExist
		}
		return 0, errors.Wrap(err, "failed to get file size")
	}

	return aws.ToInt64(resp.ContentLength), nil
}

func (s *S3) buildKey(name string) string {
	return path.Join(s.prefix, name)
}

type readerWithN struct {
	io.Reader
	n int
}

func (r *readerWithN) Read(p []byte) (n int, err error) {
	n, err = r.Reader.Read(p)
	r.n += n
	return
}

type s3logger struct{}

func (s3logger) Logf(_ logging.Classification, format string, args ...interface{}) {
	log.Debugf(format, args...)
}

func isS3NotFound(err error) bool {
	var apiErr smithy.APIError
	return errors.As(err, &apiErr) && apiErr.ErrorCode() == "NotFound"
}
