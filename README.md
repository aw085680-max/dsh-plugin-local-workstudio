# 同机工作室 · Local Agent Studio

同机工作室是 DeepSeek Harness（DSH）的本地 Bot 协作插件。可组建 Bot、建群、点名派单、顺序接力，并在群里查看成员回复、任务状态和交付文件。

- 插件包名为 **dsh-plugin-local-workstudio**，版本为 **1.0.0**，基于 r20。
- 首次安装从空白工作区开始。使用时请配置自己的模型、Bot 和工作目录。
- 本版在 Windows x64 上使用 DeepSeek Harness Desktop 0.2.2-rc.5 验证。Windows 桌面提醒和资源管理器入口依赖 Windows。

## 安装

将发布的压缩包下载到本机，通过 DSH CLI 安装。下面以桌面默认的 desktop Profile 为例。请关掉 DSH 再安装，并在安装成功后重新启动桌面客户端。

~~~powershell
dsh plugin --profile desktop add .\dsh-plugin-local-workstudio-1.0.0.tgz --offline
~~~

打开侧栏的 **同机工作室**，创建至少两个 Bot，再创建群聊。给 Bot 选择你已配置的模型。群聊中可通过点名给指定成员分配任务。要结束一件任务，回复其原消息并点名本群队长。

同一 Profile 请选择一套 Agent Community 插件。如果已经启用了 Bots 团队、Agent Collaboration 或其他使用相同服务的分支，请用另一个测试 Profile，或先备份并停用旧挂载。若要连工作区数据也隔离，请使用独立的 DSH_HOME。

## Windows 桌面提醒

默认可在群内查看任务结果和提醒。启用 Windows 弹窗及任务置顶窗时，先启动一次已安装的插件，再关闭 DSH。在已安装包的 native 目录运行以下命令。将变量设置为当前 DSH 实际使用的数据目录和桌面程序路径。

~~~powershell
.\windows-reminders.ps1 -Action Enable -DataHome $DshDataHome -DesktopExe $DshDesktopExe
~~~

脚本为该数据目录创建当前 Windows 用户的通知标识、通知链接和开始菜单快捷方式。重新启动 DSH 后生效。插件重新安装或移动时，可再运行一次更新绑定。系统通知设置会影响弹窗显示。关闭桌面提醒时运行以下命令，再重新启动 DSH。

~~~powershell
.\windows-reminders.ps1 -Action Disable -DataHome $DshDataHome
~~~

## 卸载

如果启用了 Windows 桌面提醒，先用上面的命令关闭，再卸载插件。已有工作区数据由 DSH 保留。

~~~powershell
dsh plugin --profile desktop remove dsh-plugin-local-workstudio
~~~

## 构建

仓库包含可直接打包的 JavaScript 模块、类型声明和 Windows 辅助程序的 C# 源码。在 Windows 上修改 C# 后，可运行 native/build-windows.ps1 重编两个辅助程序。仓库根目录执行 npm pack --offline --ignore-scripts 生成安装包。

## 作者与许可证

上游是 [DSH Plugin Agent Collaboration](https://github.com/Leo-sail/dsh-plugin-agent-collaboration/tree/v0.5.0)，原作者 **leochang（Leo-sail）**。本衍生版由 **Wangtongshu** 维护。保留上游 MIT 许可证中的 **Copyright (c) 2026 Chang Hao** 及上游组件的版权信息。 [MIT 许可证](LICENSE)

浏览器预览组件使用的第三方许可证随包提供。 [第三方声明](THIRD_PARTY_NOTICES.md)
