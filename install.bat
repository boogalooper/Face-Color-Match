@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

echo [Face Color Match] Python 3.11-3.14 setup
echo.

where py >nul 2>nul || (
  echo Python Launcher was not found.
  echo Install CPython 3.11, 3.12, 3.13, or 3.14 from python.org
  echo with "Python Launcher" enabled.
  pause
  exit /b 1
)

set "PYVER=%~1"
if defined PYVER goto :check_requested

for %%V in (3.14 3.13 3.12 3.11) do (
  py -%%V -c "import sys; assert sys.version_info[:2]==tuple(map(int,'%%V'.split('.')))" >nul 2>nul
  if not errorlevel 1 (
    set "PYVER=%%V"
    goto :python_found
  )
)

echo No supported Python was found.
echo Install CPython 3.11 through 3.14 and run this installer again.
pause
exit /b 1

:check_requested
if not "%PYVER%"=="3.11" if not "%PYVER%"=="3.12" if not "%PYVER%"=="3.13" if not "%PYVER%"=="3.14" (
  echo Unsupported requested Python version: %PYVER%
  echo Supported versions: 3.11, 3.12, 3.13, 3.14
  pause
  exit /b 1
)

py -%PYVER% -c "import sys; assert sys.version_info[:2]==tuple(map(int,'%PYVER%'.split('.')))" >nul 2>nul || (
  echo Python %PYVER% was not found.
  pause
  exit /b 1
)

:python_found
echo Using Python %PYVER%
py -%PYVER% -c "import sys; print(sys.version)" || goto :fail

echo.
echo Checking NumPy and OpenCV...
py -%PYVER% -c "import cv2,numpy; assert hasattr(cv2,'FaceDetectorYN_create'); print('Existing modules OK:', 'OpenCV',cv2.__version__,'NumPy',numpy.__version__)" >nul 2>nul
if errorlevel 1 (
  echo Installing required packages for Python %PYVER%...
  py -%PYVER% -m pip --version >nul 2>nul
  if errorlevel 1 (
    echo Preparing pip...
    py -%PYVER% -m ensurepip --upgrade
    if errorlevel 1 goto :fail
  )

  if "%PYVER%"=="3.11" (
    py -%PYVER% -m pip install --upgrade "numpy==2.4.6" "opencv-python-headless==4.14.0.94"
    if errorlevel 1 (
      echo System Python packages are not writable or installation failed. Retrying for the current user...
      py -%PYVER% -m pip install --user --upgrade "numpy==2.4.6" "opencv-python-headless==4.14.0.94"
    )
  ) else (
    py -%PYVER% -m pip install --upgrade "numpy==2.5.2" "opencv-python-headless==4.14.0.94"
    if errorlevel 1 (
      echo System Python packages are not writable or installation failed. Retrying for the current user...
      py -%PYVER% -m pip install --user --upgrade "numpy==2.5.2" "opencv-python-headless==4.14.0.94"
    )
  )
  if errorlevel 1 goto :fail
) else (
  echo Compatible NumPy/OpenCV already installed. Keeping the existing installation.
)

if not exist "lib\models" mkdir "lib\models"

py -%PYVER% -c "import hashlib,pathlib,sys; p=pathlib.Path(r'%~dp0lib\models\face_detection_yunet_2023mar.onnx'); ok=p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()=='8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'; sys.exit(0 if ok else 1)" >nul 2>nul
if errorlevel 1 (
  echo Downloading YuNet face detector model...
  py -%PYVER% -c "import urllib.request,pathlib,hashlib; u='https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx'; p=pathlib.Path(r'%~dp0lib\models\face_detection_yunet_2023mar.onnx'); req=urllib.request.Request(u,headers={'User-Agent':'Face-Color-Match-Installer'}); data=urllib.request.urlopen(req,timeout=60).read(); assert hashlib.sha256(data).hexdigest()=='8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4', 'Downloaded model checksum mismatch'; p.write_bytes(data); print('Saved:',p)"
  if errorlevel 1 (
    echo WARNING: YuNet model download failed.
    echo The script can still run with the less accurate built-in Haar fallback.
  )
) else (
  echo YuNet model already present.
)

echo.
echo Final check...
py -%PYVER% -c "import cv2,numpy,sys; assert (3,11)<=sys.version_info[:2]<=(3,14); assert hasattr(cv2,'FaceDetectorYN_create'); print('Python',sys.version.split()[0]); print('OpenCV',cv2.__version__); print('NumPy',numpy.__version__); print('FaceDetectorYN',hasattr(cv2,'FaceDetectorYN_create'))" || goto :fail

echo.
echo Installation completed for Python %PYVER%.
pause
exit /b 0

:fail
echo.
echo Installation failed. Review the messages above.
pause
exit /b 1
