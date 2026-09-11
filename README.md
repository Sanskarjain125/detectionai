# Local Face Scanner

This is a local-only Flask face-recognition app. It opens your default browser at `http://127.0.0.1:5000`, reads your webcam in the browser, and sends camera frames only to the Flask process running on your own computer. It does not upload images or details to a remote service.

## What you need

- Python 3.10 or 3.11 (64-bit is recommended).
- A working webcam and a current Chrome, Edge, or Firefox browser.
- Five or six clear reference photos of each person you want to recognise. This project deliberately ships without anyone's face photos.

## First-time installation

Open PowerShell in this `face_scanner` folder and run:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip setuptools wheel
pip install -r requirements.txt
python run.py
```

After the dependencies are installed, the only command needed on later runs is:

```powershell
.\.venv\Scripts\python.exe run.py
```

The launcher starts Flask and opens your default browser automatically. Leave the PowerShell window open while using the app; press `Ctrl+C` there to stop it.

## Android APK and phone camera

The companion Android project is in `android_app/`. Its debug APK is built at `android_app/app/build/outputs/apk/debug/FaceScanner.apk`. Install it on a phone connected to the same Wi-Fi as this PC. The app opens the scanner at `http://192.168.1.64:5000/` and asks for camera permission; it requests the phone's front camera. If your PC’s Wi-Fi IP changes, replace the URL in the APK's top address field with the current `http://<PC-IP>:5000/` address, then tap **Open Scanner**.

Keep `python run.py` running on the PC while using the APK. The recognition backend stays on the PC because the requested Flask + dlib `face_recognition` stack is desktop Python software; the APK securely acts as the mobile camera client. If Windows Firewall asks about Python on a private network, allow it only on your private home/office network so the phone can connect.

### Windows dependency note

The requirements use `dlib-bin==19.24.6`, a pinned prebuilt Windows wheel that provides the `dlib` module used by `face-recognition`. This avoids a CMake and Visual Studio compiler setup on standard 64-bit Python 3.10/3.11 Windows installations. The recognition code remains the requested dlib-based `face_recognition` stack.

## Enrol reference faces

1. For a new clone, copy `details.example.json` to `details.json`, then enter your own local profile details. `details.json` and `known_faces/` are intentionally excluded from Git because they can contain personal and biometric data.
2. Put your images in `known_faces/`. Each image must contain exactly one, clear, forward-facing face. Good lighting and slight angle/expression changes across photos improve reliability.
3. Name all photos for a person with the same id followed by a sequence number. For example:

   ```text
   known_faces/person1_1.jpg
   known_faces/person1_2.jpg
   known_faces/person1_3.jpg
   known_faces/person1_4.jpg
   known_faces/person1_5.jpg
   known_faces/person1_6.jpg
   ```

4. Edit `details.json` so its top-level key exactly matches that id. The value may contain any fields you want displayed:

   ```json
   {
     "person1": {
       "name": "Avery Patel",
       "age": "28",
       "department": "Research",
       "employee_id": "EMP-1042"
     }
   }
   ```

5. Restart `python run.py` after changing either reference images or `details.json`. Reference encodings are intentionally loaded once on startup for speed and consistency.

## Use the scanner

Click **Start Camera**, approve the browser's camera permission, and look into the preview with only one face visible. The app scans about every 2.5 seconds; **Scan Face** triggers a scan immediately. When a face matches, scanning pauses and the recognised profile remains visible. Click **Restart Scanning** only when you want to clear that result and scan again. A non-match displays **Face not recognized**.

The match threshold is configured by `FACE_MATCH_THRESHOLD = 0.50` near the top of `app.py`. Lower it (for example, `0.45`) to reduce false matches; raise it carefully only if valid matches are repeatedly missed.

## Troubleshooting

- **No reference faces are loaded:** add valid JPG, JPEG, PNG, or WEBP photos to `known_faces/`, with exactly one face per image, then restart.
- **No face detected:** improve lighting, face the camera, and move closer.
- **Multiple faces detected:** keep only one person in the frame.
- **Low-light message:** increase front lighting; very dark frames are rejected before recognition.
- **Camera permission denied:** use the browser’s site permissions to allow the camera for `127.0.0.1`, then reload the page.
- **Port 5000 is in use:** stop the other local server using that port, then run the launcher again.

## Privacy and limitations

Face recognition is probabilistic. Use it only with the knowledge and permission of the people enrolled, and do not use it as the sole basis for high-impact decisions. Keep `known_faces/` and `details.json` private because they contain biometric and personal information.

## Vercel deployment

The repository includes `vercel.json`, `.python-version`, and `build.py` to prevent Vercel's Python Function from crashing while importing `face_recognition`. Vercel imports `app.py` directly (it does not run `run.py`), so the build hook installs `face-recognition` against the pinned prebuilt dlib runtime.

For privacy, Git intentionally excludes `known_faces/` photos and the real `details.json`. Therefore, the Vercel page can load successfully but has no enrolled face dataset. Keep face recognition on the local server unless you deliberately choose an approved, secure biometric-data store and deployment process.
