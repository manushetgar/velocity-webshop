@echo off
rem VeloCity web shop - starts everything for the LOCAL demo with one double-click:
rem   window 1: SAP Mini-ERP   (cds watch, http://localhost:4004)
rem   window 2: web shop       (npm run dev, http://localhost:5173)
rem Close the two windows to stop everything.
rem ------------------------------------------------------------------------------------------------
rem Role in the project: a Windows batch file for the LOCAL demo only - it is not used on SAP BTP.
rem It starts the Mini-ERP of Lab 0 - the SAP CAP app, data kept in memory, HTTP basic auth with the
rem mocked user service-user - and the web shop: Express API on port 3001 plus the Vite dev server
rem for the React app on port 5173. In the shop the SAP connector Local SAP points to localhost:4004.
rem The line @echo off above must stay the FIRST line of the file: echo off stops cmd from printing
rem every command before it runs it, so the window only shows the script's own messages. The @ hides
rem the echo off command itself. Because echo is off, these rem comment lines are not printed either.
rem ------------------------------------------------------------------------------------------------

rem Folder of the Mini-ERP project from Lab 0 - the CAP app that is started with cds watch.
rem USERPROFILE is the Windows home folder of the user, e.g. C:\Users\YourName. Edit this line if the
rem ERP project lives somewhere else. set NAME=value stores the text in a variable for this script.
set ERP_DIR=%USERPROFILE%\systems-integration\src\simple-erp
rem Sanity check before anything is started: every Node.js CAP project has a package.json. If it is
rem missing, the path in ERP_DIR is wrong, so a hint is shown instead of a window with a cds error.
rem The opening parenthesis starts a block of commands that runs only when the check fails.
if not exist "%ERP_DIR%\package.json" (
  rem Tell the user which folder was checked ...
  echo Mini-ERP not found in %ERP_DIR%
  rem ... and how to fix it.
  echo Edit ERP_DIR in start-local.cmd
  rem Wait for a key press, so a window opened by double-click does not close before it is read.
  pause
  rem Leave the script with error code 1 = failure; exit /b ends only this batch file, not cmd itself.
  exit /b 1
)

rem Progress message in the launcher window.
echo Starting SAP Mini-ERP (cds watch) ...
rem Open window 1 and start the Mini-ERP in it:
rem   start "title"      opens a new console window; the first quoted argument is its window title.
rem   /D "ERP_DIR"       working directory of the new window = the Mini-ERP project folder.
rem   cmd /k             runs the command and keeps the window open afterwards, so errors stay visible.
rem   npx.cmd cds watch  npx.cmd is the Windows command script of npx; it runs the cds command line tool
rem                      of SAP CAP. cds watch serves the ERP on http://localhost:4004 by default and
rem                      restarts it when a source file changes - its in-memory data is reset each time.
start "SAP Mini-ERP - cds watch" /D "%ERP_DIR%" cmd /k npx.cmd cds watch
rem Wait 6 seconds before the shop is started. /nobreak = a key press cannot skip the wait, and the
rem countdown text is redirected to nul, i.e. hidden. Reason: the ERP should already be running when the
rem shop starts, because the shop syncs its products with the active SAP connector right at start-up.
timeout /t 6 /nobreak >nul

rem Progress message in the launcher window.
echo Starting web shop (npm run dev) ...
rem Open window 2 with the web shop. The parameter %~dp0 is the drive and folder of THIS batch file,
rem i.e. the project root, so the script works no matter from which folder it is started.
rem npm.cmd run dev runs the dev script of the root package.json: concurrently starts the Express
rem server with node --watch on port 3001 and the Vite dev server for React on port 5173, which
rem forwards all /api calls to port 3001. cmd /k keeps the window open, as above.
start "VeloCity web shop - npm run dev" /D "%~dp0" cmd /k npm.cmd run dev
rem Give the Express server and Vite 8 seconds to start before the browser is opened.
timeout /t 8 /nobreak >nul

rem Open the shop in the default web browser. The empty "" is the window title argument of start -
rem the usual safe pattern, because start treats the first quoted argument as the title.
start "" http://localhost:5173
rem Final message with the addresses of both systems, plus the supplier portal and the supplier FTP server
rem (Lab 2 extension), which are started by the shop server itself.
echo Done. Shop: http://localhost:5173   ERP: http://localhost:4004
echo       Supplier portal: http://localhost:3200   Supplier FTP: ftp://127.0.0.1:2121
rem Keep this launcher window open for 5 seconds so the message can be read, then the script ends - a window
rem opened by double-click closes. Without /nobreak a key press ends the wait early. The two other windows
rem keep running.
timeout /t 5 >nul
