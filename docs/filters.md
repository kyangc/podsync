# 节目过滤器

Podsync 支持按标题、描述、时长和发布时间过滤节目。过滤器按 feed 配置，位置是 `[feeds.<id>.filters]`。

所有过滤条件都使用 **AND 逻辑**：一期节目必须同时满足所有已配置条件，才会被下载。需要 OR 逻辑时，在单个正则里使用 `|`。

## 可用过滤项

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `title` | string | 只包含标题匹配正则的节目 |
| `not_title` | string | 排除标题匹配正则的节目 |
| `description` | string | 只包含描述匹配正则的节目 |
| `not_description` | string | 排除描述匹配正则的节目 |
| `min_duration` | int | 排除短于 N 秒的节目 |
| `max_duration` | int | 排除长于 N 秒的节目 |
| `min_age` | int | 跳过发布不到 N 天的新节目 |
| `max_age` | int | 跳过发布超过 N 天的旧节目 |

正则表达式使用 [Go regular expression syntax](https://pkg.go.dev/regexp/syntax)。

## 常见示例

### 按关键词排除节目

使用 `not_title` 和正则 alternation `|`，可以跳过包含任意关键词的节目：

```toml
[feeds.my_feed.filters]
# 跳过直播、问答和 Shorts，忽略大小写
not_title = "(?i)(live|q&a|#shorts)"
```

### 只下载匹配关键词的节目

使用 `title` 可以只下载标题匹配某类模式的节目：

```toml
[feeds.my_feed.filters]
# 只下载 tutorial 和 guide 类节目
title = "(?i)(tutorial|how.to|guide)"
```

### 按时长过滤

`min_duration` 和 `max_duration` 的单位是秒：

```toml
[feeds.my_feed.filters]
# 只下载 10 分钟到 3 小时之间的完整节目
min_duration = 600
max_duration = 10800
```

### 跳过短片、预告和片段

标题过滤可以和最小时长一起使用：

```toml
[feeds.my_feed.filters]
# 排除标题里的 clip/preview/trailer/teaser，同时跳过 5 分钟以下节目
not_title = "(?i)(clip|preview|trailer|teaser)"
min_duration = 300
```

### 只保留近期节目

使用 `max_age` 可以跳过太旧的节目：

```toml
[feeds.my_feed.filters]
# 只保留最近 90 天内发布的节目
max_age = 90
```

### 延迟下载新节目

使用 `min_age` 可以等节目发布一段时间后再下载，适合创作者可能会补剪、修正标题或替换视频的场景：

```toml
[feeds.my_feed.filters]
# 发布至少 2 天后再下载
min_age = 2
```

### 按描述关键词过滤

使用 `description` 可以只下载描述中提到某个主题的节目：

```toml
[feeds.my_feed.filters]
# 只下载描述中提到 interview 的节目
description = "(?i)interview"
```

### 组合标题和描述过滤

多个过滤项会同时生效，节目必须全部满足：

```toml
[feeds.my_feed.filters]
# 下载 Python 相关节目，但排除 beginner/intro/101 这类入门内容
title        = "(?i)python"
not_title    = "(?i)(beginner|intro|101)"
min_duration = 600
```

### 匹配精确短语

可以用 `\b` 单词边界或 `^` / `$` 锚点让匹配更精确：

```toml
[feeds.my_feed.filters]
# 只下载包含完整短语 "full episode" 的节目
title = "(?i)\\bfull episode\\b"
```

### 按标题前缀排除多个栏目

```toml
[feeds.my_feed.filters]
# 跳过以 "Shorts:" 或 "Clip:" 开头的标题
not_title = "(?i)^(shorts?:|clip:)"
```

## 注意事项

- `title` 和 `description` 是包含过滤：只有匹配的节目才会下载。
- `not_title` 和 `not_description` 是排除过滤：匹配的节目会被跳过。
- 时长和发布时间过滤总是排除范围之外的节目。
- 多个过滤项之间是 AND 逻辑；如果需要 OR 逻辑，在同一个字段里使用正则 `a|b`。
