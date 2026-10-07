# 本地定制桌面构建

[English](README.md) | 中文

## 概述

本工具生成可供隔离验证的 macOS arm64 候选应用，不安装、不启动、不退出现有应用，也不读取 Harness 的会话、设置或凭据。它要求先完成 Fork 的 Host、Client、Web 和 Desktop 构建，并使用相同产品版本的已安装应用作为基础。

## 构建候选应用

```sh
pnpm exec tsx apps/desktop/scripts/package-local-fork.mjs
```

默认基础为 `~/Applications/DeepSeek Harness.app`，输出为 `apps/desktop/.desktop-build/local-fork/candidate/DeepSeek Harness.app`。`--base-app` 可指定另一份同版本应用。`--package` 可重复指定已构建的工作区包；省略时选择相对 `--base-ref` 的改动及新增包，并包含 Web bundle 与前端。默认基点为 `dsh-v0.2.0-rc.2`。依赖不完整、缺少构建产物、版本不匹配、候选运行中或输出不是本工具拥有时，构建拒绝继续。

候选复用基础应用的 Electron、Node、pnpm、Python、primary runtime、第三方原生依赖及未修改的工作区包；修改包从本地 `pnpm pack` 的实际载荷替换，保留其嵌套依赖。该过程是本地组合构建，不能称为完整官方 release 构建。新增外部运行依赖需另行准备，不从用户 profile 或开发依赖目录静默补齐。

构建更新运行包声明、共享包清单、每个文件的字节哈希和可执行权限，再验证最终 ASAR 与 descriptor 一致；原有 unpack 位置及原生签名保留。应用保留产品名、Bundle ID、资源布局和版本，去除官方强制更新声明与更新 feed，更新 `ElectronAsarIntegrity` 并只对外层应用进行 ad-hoc 签名。它没有官方 Developer ID 签名或公证。

输出中的 `build-result.json` 记录基础应用、基础 ASAR 哈希、源码 commit、dirty 状态、替换包和验签结果；`local-fork-package-set.json` 与 `packed/` 保存本轮实际包及 SHA512。基础安装包没有旧 npm tarballs，因此复用包仅记录原运行包身份，不虚构官方 package-set 完整构建证据。构建结果不代表启动或模型制造验证。

只允许重建 `.desktop-build/local-fork` 内带本工具 ownership 标记的候选目录。替换正式应用必须另行确认实时空闲、正常退出及所有进程退出，保留旧应用备份，并保持 `.dsh` 与 Electron userData；工具自身不执行该步骤。现有 AEA 的固定 `app.asar/dsh` 引用需要最终保留原安装路径。

## 隔离启动验证

隔离启动检查使用 `node apps/desktop/scripts/smoke-local-fork.mjs --app <absolute-candidate-path>`。它创建独立的 Harness home、Electron userData 和随机监听端口，跳过登录进入工作区，不提交对话或模型任务；完成后请求正常退出并核对进程消失。失败时只允许终止自己启动的候选主进程，强制终止不记检查通过。私有检查目录和结果保留用于诊断。主进程连接后切换日志到私有目录；连接前的极早启动失败仍可能使用 Electron 的默认 macOS 日志目录。
