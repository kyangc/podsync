package remote

import (
	"context"
	"io"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/gabriel-vasile/mimetype"
	"github.com/pkg/errors"

	"github.com/mxpv/podsync/pkg/model"
)

type R2Config struct {
	Endpoint        string
	Bucket          string
	Prefix          string
	AccessKeyID     string
	SecretAccessKey string
}

type R2Publisher struct {
	api    r2API
	bucket string
}

type r2API interface {
	PutObject(context.Context, *s3.PutObjectInput, ...func(*s3.Options)) (*s3.PutObjectOutput, error)
	HeadObject(context.Context, *s3.HeadObjectInput, ...func(*s3.Options)) (*s3.HeadObjectOutput, error)
}

func NewR2Publisher(cfg R2Config) (*R2Publisher, error) {
	client, err := newR2Client(cfg)
	if err != nil {
		return nil, err
	}
	return &R2Publisher{api: client, bucket: cfg.Bucket}, nil
}

func newR2Client(cfg R2Config) (*s3.Client, error) {
	if cfg.Endpoint == "" || cfg.Bucket == "" || cfg.AccessKeyID == "" || cfg.SecretAccessKey == "" {
		return nil, errors.New("r2 endpoint, bucket, access key id, and secret access key are required")
	}
	awsCfg, err := config.LoadDefaultConfig(
		context.Background(),
		config.WithRegion("auto"),
		config.WithBaseEndpoint(cfg.Endpoint),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(cfg.AccessKeyID, cfg.SecretAccessKey, "")),
	)
	if err != nil {
		return nil, err
	}
	client := s3.NewFromConfig(awsCfg, func(options *s3.Options) {
		options.UsePathStyle = true
	})
	return client, nil
}

func NewR2PublisherWithAPI(api r2API, bucket string) *R2Publisher {
	return &R2Publisher{api: api, bucket: bucket}
}

func DetectMimeType(reader io.ReadSeeker) (string, error) {
	var buf [512]byte
	n, err := reader.Read(buf[:])
	if err != nil && err != io.EOF {
		return "", err
	}
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	return mimetype.Detect(buf[:n]).String(), nil
}

func (p *R2Publisher) Upload(ctx context.Context, task *model.RemotePublishTask, reader io.ReadSeeker) error {
	if task.R2Key == "" {
		return errors.New("remote publish task r2_key is required")
	}
	if task.MimeType == "" {
		return errors.New("remote publish task mime_type is required")
	}
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		return err
	}
	_, err := p.api.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(p.bucket),
		Key:           aws.String(task.R2Key),
		Body:          reader,
		ContentLength: aws.Int64(task.Size),
		ContentType:   aws.String(task.MimeType),
	})
	if err != nil {
		return err
	}
	head, err := p.api.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(p.bucket),
		Key:    aws.String(task.R2Key),
	})
	if err != nil {
		return err
	}
	if head.ContentLength == nil || aws.ToInt64(head.ContentLength) != task.Size {
		return errors.Errorf("r2 object size mismatch: got %d want %d", aws.ToInt64(head.ContentLength), task.Size)
	}
	return nil
}
