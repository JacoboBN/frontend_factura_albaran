# Embedded Binaries for DriveShare

This directory contains the embedded binaries for Poppler and Tesseract that will be bundled with the Electron app.

## Required Binaries

### 1. Tesseract OCR
- **Location**: `win/tesseract/`
- **Files needed**:
  - `tesseract.exe` (main executable)
  - Required DLLs (libtesseract-5.dll, leptonica-1.82.0.dll, etc.)
- **Download**: https://github.com/UB-Mannheim/tesseract/wiki (Tesseract 5.x for Windows)
- **Language data**: Download `spa.traineddata` and place in `tessdata/` folder

### 2. Poppler (PDF to PNG converter)
- **Location**: `win/poppler/`
- **Files needed**:
  - `pdftoppm.exe` (main executable)
  - Required DLLs (poppler-cpp.dll, poppler.dll, etc.)
- **Download**: Get from Poppler Windows builds (search for "poppler windows binaries")

## Installation Instructions

1. Download the Windows binaries for both Tesseract and Poppler
2. Extract the executables and DLLs to their respective directories
3. Ensure `spa.traineddata` is in `tesseract/tessdata/`
4. Test that the binaries work by running them from command line
5. Build the Electron app with `npm run build:win`

## Notes

- All binaries must be 64-bit versions to match Electron's architecture
- The build process will copy these files to `process.resourcesPath/bin` in the final app
- The backend code automatically detects development vs production paths
