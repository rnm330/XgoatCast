#define MyAppName "XgoatCast"
#ifndef MyAppVersion
  #define MyAppVersion "0.0.1"
#endif
#ifndef MyAppFullVersion
  #define MyAppFullVersion "0.0.1-beta.1"
#endif
#define MyAppPublisher "XgoatCast"
#define MyAppExeName "XgoatCast.exe"

[Setup]
AppId={{C5B4A0D4-75A1-4E3F-8E1F-4E1A6B9D4C01}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppFullVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\XgoatCast
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\out
OutputBaseFilename=XgoatCast-{#MyAppFullVersion}-win-x64-setup
SetupIconFile=..\app.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
UninstallDisplayName={#MyAppName} {#MyAppFullVersion}
UninstallDisplayIcon={app}\{#MyAppExeName}

[Files]
Source: "..\out\XgoatCast-win-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加快捷方式："

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent
