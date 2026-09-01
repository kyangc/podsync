package remote

import (
	"context"
	"io"
	"os"
	"path/filepath"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/pkg/errors"

	"github.com/mxpv/podsync/pkg/model"
)

type MissingSourceRestorer interface {
	Restore(ctx context.Context, task *model.RemotePublishTask, dryRun bool) error
}

type r2RecoveryAPI interface {
	HeadObject(context.Context, *s3.HeadObjectInput, ...func(*s3.Options)) (*s3.HeadObjectOutput, error)
	GetObject(context.Context, *s3.GetObjectInput, ...func(*s3.Options)) (*s3.GetObjectOutput, error)
}

type R2SourceRestorer struct {
	api        r2RecoveryAPI
	bucket     string
	sourceRoot string
}

func NewR2SourceRestorer(cfg R2Config, sourceRoot string) (*R2SourceRestorer, error) {
	client, err := newR2Client(cfg)
	if err != nil {
		return nil, err
	}
	return NewR2SourceRestorerWithAPI(client, cfg.Bucket, sourceRoot)
}

func NewR2SourceRestorerWithAPI(api r2RecoveryAPI, bucket string, sourceRoot string) (*R2SourceRestorer, error) {
	if api == nil || bucket == "" || sourceRoot == "" {
		return nil, errors.New("r2 recovery api, bucket, and source root are required")
	}
	absoluteRoot, err := filepath.Abs(sourceRoot)
	if err != nil {
		return nil, err
	}
	canonicalRoot, err := filepath.EvalSymlinks(absoluteRoot)
	if err != nil {
		return nil, errors.Wrap(err, "resolve r2 recovery source root")
	}
	return &R2SourceRestorer{api: api, bucket: bucket, sourceRoot: canonicalRoot}, nil
}

func (r *R2SourceRestorer) Restore(ctx context.Context, task *model.RemotePublishTask, dryRun bool) error {
	sourcePath, err := r.sourcePath(task, !dryRun)
	if err != nil {
		return err
	}
	if exists, err := recoveredSourceExists(sourcePath, task.Size); err != nil || exists {
		return err
	}
	if dryRun {
		head, err := r.api.HeadObject(ctx, &s3.HeadObjectInput{
			Bucket: aws.String(r.bucket),
			Key:    aws.String(task.R2Key),
		})
		if err != nil {
			return err
		}
		return requireRecoverySize(head.ContentLength, task.Size)
	}

	object, err := r.api.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(r.bucket),
		Key:    aws.String(task.R2Key),
	})
	if err != nil {
		return err
	}
	if object.Body == nil {
		return errors.New("r2 recovery object body is missing")
	}
	if err := requireRecoverySize(object.ContentLength, task.Size); err != nil {
		_ = object.Body.Close()
		return err
	}

	temp, err := os.CreateTemp(filepath.Dir(sourcePath), ".podsync-r2-recovery-*")
	if err != nil {
		_ = object.Body.Close()
		return err
	}
	tempPath := temp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tempPath)
		}
	}()

	written, copyErr := io.Copy(temp, object.Body)
	closeBodyErr := object.Body.Close()
	if copyErr != nil {
		_ = temp.Close()
		return copyErr
	}
	if closeBodyErr != nil {
		_ = temp.Close()
		return closeBodyErr
	}
	if written != task.Size {
		_ = temp.Close()
		return errors.Wrapf(ErrHardlinkSourceSizeMismatch, "restored %d bytes want %d", written, task.Size)
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Chmod(0644); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Link(tempPath, sourcePath); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return err
		}
		if exists, existingErr := recoveredSourceExists(sourcePath, task.Size); existingErr != nil || !exists {
			return existingErr
		}
	}
	if err := os.Remove(tempPath); err != nil {
		return err
	}
	cleanup = false
	return nil
}

func (r *R2SourceRestorer) sourcePath(task *model.RemotePublishTask, createParent bool) (string, error) {
	if task == nil || task.MediaPath == "" || task.R2Key == "" || task.Size < 0 {
		return "", errors.New("r2 recovery task requires media_path, r2_key, and non-negative size")
	}
	path, err := pathWithinRoot(r.sourceRoot, task.MediaPath)
	if err != nil {
		return "", errors.Wrap(err, "invalid recovery media_path")
	}
	requestedParent := filepath.Dir(path)
	existingParent := requestedParent
	missingParents := []string{}
	for {
		info, statErr := os.Lstat(existingParent)
		if statErr == nil {
			if !info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
				return "", errors.Wrap(ErrUnsafeMediaPath, "recovery parent is not a directory")
			}
			break
		}
		if !errors.Is(statErr, os.ErrNotExist) {
			return "", statErr
		}
		if existingParent == r.sourceRoot {
			return "", statErr
		}
		missingParents = append([]string{filepath.Base(existingParent)}, missingParents...)
		existingParent = filepath.Dir(existingParent)
	}
	canonicalParent, err := filepath.EvalSymlinks(existingParent)
	if err != nil {
		return "", err
	}
	if !isWithinRoot(r.sourceRoot, canonicalParent) {
		return "", errors.Wrap(ErrUnsafeMediaPath, "recovery media_path resolves outside source root")
	}
	parent := canonicalParent
	for _, component := range missingParents {
		parent = filepath.Join(parent, component)
	}
	if createParent {
		if err := os.MkdirAll(parent, 0755); err != nil {
			return "", err
		}
		parent, err = filepath.EvalSymlinks(parent)
		if err != nil {
			return "", err
		}
		if !isWithinRoot(r.sourceRoot, parent) {
			return "", errors.Wrap(ErrUnsafeMediaPath, "recovery parent resolves outside source root")
		}
	}
	return filepath.Join(parent, filepath.Base(path)), nil
}

func recoveredSourceExists(path string, expectedSize int64) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return false, errors.Wrap(ErrUnsafeMediaPath, "recovered source is not a regular file")
	}
	if info.Size() != expectedSize {
		return false, errors.Wrapf(ErrHardlinkSourceSizeMismatch, "existing source has %d bytes want %d", info.Size(), expectedSize)
	}
	return true, nil
}

func requireRecoverySize(got *int64, want int64) error {
	if got == nil || aws.ToInt64(got) != want {
		return errors.Wrapf(ErrHardlinkSourceSizeMismatch, "r2 object has %d bytes want %d", aws.ToInt64(got), want)
	}
	return nil
}
