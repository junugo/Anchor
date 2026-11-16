; Anchor 桌面端（Rust）安装包脚本 — Inno Setup 6+
; 用法：cargo build --release 后用 Inno Setup 编译本脚本
; 输出：Anchor Setup 0.1.0.exe（对齐旧版 electron-builder 产物命名）

#define AppName "Anchor"
; AppVersion 允许命令行 /DAppVersion=x.y.z 覆盖（ISPP 中脚本 #define 优先级
; 高于命令行定义，必须包 #ifndef 才能让 /D 生效）；CI 打包传 tag 版本
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#define AppExe "anchor-desktop.exe"

[Setup]
AppId={{A9C1E7B2-3F4A-4E5D-9C0B-1A2B3C4D5E6F}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=junugo
DefaultDirName={autopf}\Anchor
DefaultGroupName={#AppName}
OutputDir=..\release
OutputBaseFilename=Anchor Setup {#AppVersion}
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
CloseApplications=yes

[Files]
Source: "..\target\release\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"

[Registry]
; 自启由应用内设置管理（HKCU Run 键），安装器不重复写入

[Run]
Filename: "{app}\{#AppExe}"; Description: "启动 {#AppName}"; Flags: nowait postinstall skipifsilent
