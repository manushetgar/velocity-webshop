@echo off
rem Local demo: starts the Mini-ERP (cds watch, :4004) and the shop (npm run dev, :5173) in two windows.
rem Edit ERP_DIR if the course repository is cloned elsewhere.
set ERP_DIR=%USERPROFILE%\systems-integration\src\simple-erp
if not exist "%ERP_DIR%\package.json" (
  echo Mini-ERP not found in %ERP_DIR%
  echo Edit ERP_DIR in start-local.cmd
  pause
  exit /b 1
)

echo Starting SAP Mini-ERP (cds watch) ...
start "SAP Mini-ERP - cds watch" /D "%ERP_DIR%" cmd /k npx.cmd cds watch
rem The shop syncs with the ERP on start-up, so give the ERP a head start.
timeout /t 6 /nobreak >nul

echo Starting web shop (npm run dev) ...
start "VeloCity web shop - npm run dev" /D "%~dp0" cmd /k npm.cmd run dev
timeout /t 8 /nobreak >nul

start "" http://localhost:5173
echo Done. Shop: http://localhost:5173   ERP: http://localhost:4004
echo       Supplier portal: http://localhost:3200   Supplier FTP: ftp://127.0.0.1:2121
timeout /t 5 >nul