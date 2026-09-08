package remote

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/pkg/errors"

	"github.com/mxpv/podsync/pkg/model"
)

var (
	ErrHardlinkSourceSizeMismatch = errors.New("hardlink source size mismatch")
	ErrHardlinkTargetConflict     = errors.New("hardlink target conflicts with source")
)

type HardlinkPublisher struct {
	sourceRoot string
	publicRoot string
}

type HardlinkStore struct {
	publicRoot string
}

func NewHardlinkPublisher(sourceRoot string, publicRoot string) (*HardlinkPublisher, error) {
	if sourceRoot == "" || publicRoot == "" {
		return nil, errors.New("hardlink publisher source and public roots are required")
	}
	absoluteSourceRoot, err := filepath.Abs(sourceRoot)
	if err != nil {
		return nil, err
	}
	canonicalSourceRoot, err := filepath.EvalSymlinks(absoluteSourceRoot)
	if err != nil {
		return nil, errors.Wrap(err, "resolve hardlink source root")
	}
	absolutePublicRoot, err := filepath.Abs(publicRoot)
	if err != nil {
		return nil, err
	}
	canonicalPublicRoot, err := filepath.EvalSymlinks(absolutePublicRoot)
	if err != nil {
		return nil, errors.Wrap(err, "resolve hardlink public root")
	}
	return &HardlinkPublisher{
		sourceRoot: canonicalSourceRoot,
		publicRoot: canonicalPublicRoot,
	}, nil
}

func NewHardlinkStore(publicRoot string) (*HardlinkStore, error) {
	if publicRoot == "" {
		return nil, errors.New("hardlink public root is required")
	}
	absolutePublicRoot, err := filepath.Abs(publicRoot)
	if err != nil {
		return nil, err
	}
	canonicalPublicRoot, err := filepath.EvalSymlinks(absolutePublicRoot)
	if err != nil {
		return nil, errors.Wrap(err, "resolve hardlink public root")
	}
	return &HardlinkStore{publicRoot: canonicalPublicRoot}, nil
}

func (s *HardlinkStore) Exists(key string) (bool, error) {
	path, err := s.existingPath(key)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return false, errors.Wrap(ErrUnsafeMediaPath, "hardlink target is not a regular file")
	}
	return true, nil
}

func (s *HardlinkStore) Delete(key string) error {
	path, err := s.existingPath(key)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return errors.Wrap(ErrUnsafeMediaPath, "hardlink target is not a regular file")
	}
	return os.Remove(path)
}

func (s *HardlinkStore) existingPath(key string) (string, error) {
	path, err := pathWithinRoot(s.publicRoot, key)
	if err != nil {
		return "", err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		return "", err
	}
	if !isWithinRoot(s.publicRoot, parent) {
		return "", errors.Wrap(ErrUnsafeMediaPath, "hardlink key resolves outside public root")
	}
	return filepath.Join(parent, filepath.Base(path)), nil
}

func (p *HardlinkPublisher) Published(task *model.RemotePublishTask) (bool, error) {
	_, targetPath, sourceInfo, err := p.paths(task)
	if err != nil {
		return false, err
	}
	targetInfo, err := os.Lstat(targetPath)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if targetInfo.Mode()&os.ModeSymlink != 0 || !targetInfo.Mode().IsRegular() {
		return false, errors.Wrap(ErrUnsafeMediaPath, "hardlink target is not a regular file")
	}
	targetInfo, err = os.Stat(targetPath)
	if err != nil {
		return false, err
	}
	if !os.SameFile(sourceInfo, targetInfo) {
		return false, errors.Wrap(ErrHardlinkTargetConflict, "hardlink target already exists with different content")
	}
	return true, nil
}

func (p *HardlinkPublisher) Upload(_ context.Context, task *model.RemotePublishTask, _ io.ReadSeeker) error {
	sourcePath, targetPath, sourceInfo, err := p.paths(task)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
		return err
	}
	canonicalTargetParent, err := filepath.EvalSymlinks(filepath.Dir(targetPath))
	if err != nil {
		return err
	}
	if !isWithinRoot(p.publicRoot, canonicalTargetParent) {
		return errors.Wrap(ErrUnsafeMediaPath, "r2_key resolves outside public root")
	}
	targetPath = filepath.Join(canonicalTargetParent, filepath.Base(targetPath))
	if targetInfo, err := os.Lstat(targetPath); err == nil && targetInfo.Mode()&os.ModeSymlink != 0 {
		return errors.Wrap(ErrUnsafeMediaPath, "r2_key target is a symlink")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Link(sourcePath, targetPath); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return err
		}
		targetInfo, statErr := os.Stat(targetPath)
		if statErr != nil {
			return statErr
		}
		if !os.SameFile(sourceInfo, targetInfo) {
			return errors.Wrap(ErrHardlinkTargetConflict, "hardlink target already exists with different content")
		}
	}
	return nil
}

func (p *HardlinkPublisher) paths(task *model.RemotePublishTask) (string, string, os.FileInfo, error) {
	if task == nil || task.MediaPath == "" || task.R2Key == "" {
		return "", "", nil, errors.New("hardlink publish task requires media_path and r2_key")
	}

	sourcePath, err := pathWithinRoot(p.sourceRoot, task.MediaPath)
	if err != nil {
		return "", "", nil, errors.Wrap(err, "invalid media_path")
	}
	sourcePath, err = filepath.EvalSymlinks(sourcePath)
	if err != nil {
		return "", "", nil, err
	}
	if !isWithinRoot(p.sourceRoot, sourcePath) {
		return "", "", nil, errors.Wrap(ErrUnsafeMediaPath, "media_path resolves outside source root")
	}
	targetPath, err := pathWithinRoot(p.publicRoot, task.R2Key)
	if err != nil {
		return "", "", nil, errors.Wrap(err, "invalid r2_key")
	}
	sourceInfo, err := os.Stat(sourcePath)
	if err != nil {
		return "", "", nil, err
	}
	if !sourceInfo.Mode().IsRegular() {
		return "", "", nil, errors.Wrap(ErrUnsafeMediaPath, "hardlink source is not a regular file")
	}
	if sourceInfo.Size() != task.Size {
		return "", "", nil, errors.Wrapf(ErrHardlinkSourceSizeMismatch, "got %d want %d", sourceInfo.Size(), task.Size)
	}
	return sourcePath, targetPath, sourceInfo, nil
}

func pathWithinRoot(root string, name string) (string, error) {
	path := filepath.FromSlash(name)
	if filepath.IsAbs(path) {
		return "", ErrUnsafeMediaPath
	}
	clean := filepath.Clean(path)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) {
		return "", ErrUnsafeMediaPath
	}
	return filepath.Join(root, clean), nil
}

func isWithinRoot(root string, path string) bool {
	relative, err := filepath.Rel(root, path)
	if err != nil || filepath.IsAbs(relative) {
		return false
	}
	return relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator))
}
