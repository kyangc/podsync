package remote

import (
	"context"
	"io"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/credentials"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/s3"
	"github.com/aws/aws-sdk-go/service/s3/s3iface"
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
	api    s3iface.S3API
	bucket string
}

func NewR2Publisher(cfg R2Config) (*R2Publisher, error) {
	if cfg.Endpoint == "" || cfg.Bucket == "" || cfg.AccessKeyID == "" || cfg.SecretAccessKey == "" {
		return nil, errors.New("r2 endpoint, bucket, access key id, and secret access key are required")
	}
	awsCfg := aws.NewConfig().
		WithEndpoint(cfg.Endpoint).
		WithRegion("auto").
		WithS3ForcePathStyle(true).
		WithCredentials(credentials.NewStaticCredentials(cfg.AccessKeyID, cfg.SecretAccessKey, ""))
	sess, err := session.NewSession(awsCfg)
	if err != nil {
		return nil, err
	}
	return &R2Publisher{api: s3.New(sess), bucket: cfg.Bucket}, nil
}

func NewR2PublisherWithAPI(api s3iface.S3API, bucket string) *R2Publisher {
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
	_, err := p.api.PutObjectWithContext(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(p.bucket),
		Key:           aws.String(task.R2Key),
		Body:          reader,
		ContentLength: aws.Int64(task.Size),
		ContentType:   aws.String(task.MimeType),
	})
	if err != nil {
		return err
	}
	head, err := p.api.HeadObjectWithContext(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(p.bucket),
		Key:    aws.String(task.R2Key),
	})
	if err != nil {
		return err
	}
	if head.ContentLength == nil || *head.ContentLength != task.Size {
		return errors.Errorf("r2 object size mismatch: got %d want %d", aws.Int64Value(head.ContentLength), task.Size)
	}
	return nil
}
