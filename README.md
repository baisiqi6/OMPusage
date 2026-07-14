# OMPusage

OMPusage 是一个 [Oh My Pi](https://github.com/can1357/oh-my-pi) 本地扩展，在编辑器下方集中显示当前会话、本机今日 Token 用量，以及 DeepSeek、GLM、Kimi、MiniMax 的官方额度与重置时间。

## 功能

- 当前会话 Token 与 Sub-agent 用量
- 本机自然日 DeepSeek / MiniMax Token 汇总
- DeepSeek 余额
- GLM 5h / 7d 配额与近 7 天 Token、调用次数
- Kimi 5h / 7d 配额与官方重置倒计时
- MiniMax 5h / 7d Token Plan 配额与重置倒计时
- OMP 风格终端配色、固定列宽和旧数据降级提示

## 安装

项目需要放在 OMP 扩展扫描目录中，推荐使用符号链接：

```bash
git clone https://github.com/baisiqi6/OMPusage.git ~/projects/OMPusage
ln -s ~/projects/OMPusage ~/.omp/agent/extensions/ompusage
```

重启 OMP 后生效。

## 凭证

扩展优先复用 OMP 已保存的供应商凭证，不会把凭证写入项目文件。也可通过以下环境变量提供：

- `DEEPSEEK_API_KEY`
- `ZHIPU_API_KEY` / `GLM_TOKEN`
- `KIMI_CODE_API_KEY` / `KIMI_API_KEY`
- `MINIMAX_CODE_CN_API_KEY` / `MINIMAX_CODE_API_KEY` / `MINIMAX_API_KEY`

## 本地用量口径

- 当前会话：`input + output + cacheWrite`
- 本机今日用量：`input + output + cacheRead + cacheWrite`
- 今日统计按本机时区自然日计算，递归包含已关闭会话和 Sub-agent 会话
- 本机今日用量目前汇总 DeepSeek 与 MiniMax

## 开发

```bash
bun test
bun run build
```

运行源码是 `index.ts`，测试位于 `index.test.ts`。构建产物输出到 `dist/`，不提交到 Git。
