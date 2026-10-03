@echo off
setlocal
if not "%~1"=="" call "%~1"
pushd "%~dp0"
if not exist out mkdir out
rc.exe /nologo /fo out\app.res app.rc
if errorlevel 1 exit /b 1
cl.exe /nologo /std:c++17 /EHsc /MT /O2 /W3 /utf-8 /DUNICODE /D_UNICODE /DNOMINMAX /DWIN32_LEAN_AND_MEAN /I deps /I deps\agora\sdk\high_level_api\include main.cpp audio.cpp session.cpp /Foout\ /Feout\XgoatCast.exe /link /SUBSYSTEM:WINDOWS /MANIFEST:NO out\app.res deps\agora\sdk\x86_64\agora_rtc_sdk.dll.lib winhttp.lib dwmapi.lib gdiplus.lib d2d1.lib dwrite.lib comctl32.lib shell32.lib shlwapi.lib ole32.lib oleaut32.lib uuid.lib winmm.lib mmdevapi.lib advapi32.lib user32.lib gdi32.lib
if errorlevel 1 exit /b 1
popd
exit /b 0
