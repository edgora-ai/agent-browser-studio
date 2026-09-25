# Documentation / 文档

## English

- [User Guide](USER_GUIDE.en.md)
- [Improvement Roadmap](improvement-roadmap.md)
- [Security Policy](../SECURITY.md)
- [Privacy Notice](../PRIVACY.md)
- [Acceptable Use Policy](../ACCEPTABLE_USE.md)
- [Contributing](../CONTRIBUTING.md)

## 简体中文

- [使用手册](USER_GUIDE.zh-CN.md)
- [改进路线图](improvement-roadmap.md)
- [问题追踪表与验收标准](review/issue-tracker.md)（唯一权威状态表）
- [项目问题清单与优化建议（2026-09-25）](review/project-issues-and-optimization-2026-09-25.md)（复核证据、优先级与实施建议）
- [安全政策](../SECURITY.md)
- [隐私说明](../PRIVACY.md)
- [可接受使用政策](../ACCEPTABLE_USE.md)
- [贡献指南](../CONTRIBUTING.md)

## Release checks / 发布检查

Before publishing a public repository or release artifact, run:

```bash
npm run build
npm test
npm audit --json
```

在公开仓库或发布构建产物之前，请运行：

```bash
npm run build
npm test
npm audit --json
```

Do not commit local runtime data such as `.env`, `config.json`, sqlite databases, cookies, Local Storage, Session Storage, audit logs, screenshots, E2E userdata, `dist/`, or `node_modules/`.

不要提交本地运行数据，例如 `.env`、`config.json`、sqlite 数据库、Cookies、Local Storage、Session Storage、审计日志、截图、E2E userdata、`dist/` 或 `node_modules/`。
