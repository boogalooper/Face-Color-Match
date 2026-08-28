@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo [Face Color Match] Python 3.11 setup
where py >nul 2>nul || (
  echo Python Launcher was not found.
  echo Install CPython 3.11 from python.org with "Python Launcher" enabled.
  pause
  exit /b 1
)

py -3.11 -c "import sys; assert sys.version_info[:2]==(3,11); print(sys.version)" || (
  echo Python 3.11 was not found.
  pause
  exit /b 1
)

echo Checking NumPy and OpenCV...
py -3.11 -c "import cv2,numpy; assert hasattr(cv2,'FaceDetectorYN_create'); print('Existing modules OK:', 'OpenCV',cv2.__version__,'NumPy',numpy.__version__)" >nul 2>nul
if errorlevel 1 (
  echo Installing required packages into system Python 3.11...
  py -3.11 -m pip install --upgrade pip
  if errorlevel 1 goto :fail
  py -3.11 -m pip install --upgrade "numpy==2.4.6" "opencv-python-headless==4.14.0.94"
  if errorlevel 1 goto :fail
) else (
  echo Compatible NumPy/OpenCV already installed. Keeping the existing installation.
)

if not exist "lib\models" mkdir "lib\models"
py -3.11 -c "import hashlib,pathlib,sys; p=pathlib.Path(r'%~dp0lib\models\face_detection_yunet_2023mar.onnx'); ok=p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()=='8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'; sys.exit(0 if ok else 1)" >nul 2>nul
if errorlevel 1 (
  echo Downloading YuNet face detector model...
  py -3.11 -c "import urllib.request,pathlib,hashlib; u='https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx'; p=pathlib.Path(r'%~dp0lib\models\face_detection_yunet_2023mar.onnx'); req=urllib.request.Request(u,headers={'User-Agent':'Face-Color-Match-Installer'}); data=urllib.request.urlopen(req,timeout=60).read(); assert hashlib.sha256(data).hexdigest()=='8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4', 'Downloaded model checksum mismatch'; p.write_bytes(data); print('Saved:',p)"
  if errorlevel 1 (
    echo WARNING: YuNet model download failed.
    echo The script can still run with the less accurate built-in Haar fallback.
  )
) else (
  echo YuNet model already present.
)

py -3.11 -c "import cv2,numpy; print('OpenCV',cv2.__version__); print('NumPy',numpy.__version__); print('FaceDetectorYN',hasattr(cv2,'FaceDetectorYN_create'))" || goto :fail

echo.
echo Installation completed for Python 3.11.
pause
exit /b 0

:fail
echo.
echo Installation failed. Review the messages above.
pause
exit /b 1
