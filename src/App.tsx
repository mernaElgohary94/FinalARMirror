
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  bootstrapCameraKit,
  createMediaStreamSource,
  Transform2D,
  type CameraKit,
  type CameraKitSession,
} from '@snap/camera-kit';
import QRCode from 'qrcode';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

const API_TOKEN = import.meta.env.VITE_SNAP_CAMERA_KIT_API_TOKEN as string | undefined;
const LENS_GROUP_ID = import.meta.env.VITE_SNAP_LENS_GROUP_ID as string | undefined;
const LENS_ID = import.meta.env.VITE_SNAP_LENS_ID as string | undefined;
const CLOUDINARY_CLOUD_NAME = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME as string | undefined;
const CLOUDINARY_UPLOAD_PRESET = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET as string | undefined;
const IMGBB_API_KEY = import.meta.env.VITE_IMGBB_API_KEY as string | undefined;

function isVictorySign(landmarks: { x: number; y: number }[]) {
  const indexTip = landmarks[8];
  const indexPip = landmarks[6];
  const indexMcp = landmarks[5];
  const middleTip = landmarks[12];
  const middlePip = landmarks[10];
  const middleMcp = landmarks[9];
  const ringTip = landmarks[16];
  const ringMcp = landmarks[13];
  const pinkyTip = landmarks[20];
  const pinkyMcp = landmarks[17];
  return indexTip.y < indexMcp.y - 0.04 && indexTip.y < indexPip.y
    && middleTip.y < middleMcp.y - 0.04 && middleTip.y < middlePip.y
    && ringTip.y > ringMcp.y - 0.01 && pinkyTip.y > pinkyMcp.y - 0.01
    && Math.abs(indexTip.x - middleTip.x) > 0.04;
}

async function uploadCapture(imageData: string) {
  if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_UPLOAD_PRESET) {
    const formData = new FormData();
    formData.append('file', imageData);
    formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
    const response = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, { method: 'POST', body: formData });
    if (!response.ok) throw new Error(`Cloudinary upload failed (${response.status}).`);
    return (await response.json() as { secure_url: string }).secure_url;
  }
  if (IMGBB_API_KEY) {
    const formData = new FormData();
    formData.append('image', imageData.split(',')[1] ?? imageData);
    const response = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, { method: 'POST', body: formData });
    if (!response.ok) throw new Error(`ImgBB upload failed (${response.status}).`);
    return (await response.json() as { data: { url: string } }).data.url;
  }
  throw new Error('Configure Cloudinary or ImgBB upload credentials in .env to enable QR sharing.');
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputVideoRef = useRef<HTMLVideoElement>(null);
  const kitRef = useRef<CameraKit | null>(null);
  const sessionRef = useRef<CameraKitSession | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const victoryStartRef = useRef<number | null>(null);
  const captureInProgressRef = useRef(false);
  const countdownRef = useRef<number | null>(null);
  const [error, setError] = useState('');
  const [lensLoading, setLensLoading] = useState(true);
  const [needsUnmute, setNeedsUnmute] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [victoryHeld, setVictoryHeld] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [qrCode, setQrCode] = useState('');
  const [qrCountdown, setQrCountdown] = useState(30);

  useEffect(() => { countdownRef.current = countdown; }, [countdown]);

  const setCamera = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    await session.pause();
    const video = {
      facingMode: { ideal: 'user' },
      width: { ideal: 720 },
      height: { ideal: 1280 },
      aspectRatio: 9 / 16,
    };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video,
        audio: false,
      });
    } catch (reason) {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    }
    streamRef.current = stream;
    setCameraStream(stream);
    const source = createMediaStreamSource(stream, { cameraType: 'user' });
    source.setTransform(Transform2D.MirrorX);
    await session.setSource(source);
    // Camera Kit can reset the transform while attaching a new source.
    // Apply it again so the front-camera preview keeps mirror left/right behavior.
    source.setTransform(Transform2D.MirrorX);
    await session.play();
  }, []);

  useEffect(() => {
    let disposed = false;
    async function start() {
      if (!API_TOKEN || !LENS_GROUP_ID || !LENS_ID) {
        setError('Add your Camera Kit API token, Lens Group ID, and Lens ID to .env, then restart the app.');
        setLensLoading(false);
        return;
      }
      if (!canvasRef.current) return;
      try {
        const cameraKit = await bootstrapCameraKit({ apiToken: API_TOKEN });
        if (disposed) return;
        kitRef.current = cameraKit;
        const session = await cameraKit.createSession({ liveRenderTarget: canvasRef.current });
        sessionRef.current = session;
        session.events.addEventListener('error', ({ detail }) => {
          if (detail.error.name === 'LensVideoPlaybackMutedError') setNeedsUnmute(true);
        });
        const loadedLens = await cameraKit.lensRepository.loadLens(LENS_ID, LENS_GROUP_ID);
        if (disposed) return;
        await session.applyLens(loadedLens);
        await setCamera();
        if (!disposed) setLensLoading(false);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Unable to open the camera.');
        if (!disposed) setLensLoading(false);
      }
    }
    void start();
    return () => {
      disposed = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      void sessionRef.current?.destroy();
      void kitRef.current?.destroy();
    };
  }, [setCamera]);

  const createAndShareCapture = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || captureInProgressRef.current) return;
    captureInProgressRef.current = true;
    setVictoryHeld(false);
    try {
      const publicUrl = await uploadCapture(canvas.toDataURL('image/jpeg', 0.92));
      setQrCode(await QRCode.toDataURL(publicUrl, { width: 320, margin: 2, errorCorrectionLevel: 'Q' }));
      setQrCountdown(30);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to create the QR code.');
    } finally {
      captureInProgressRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!cameraStream || !inputVideoRef.current) return;
    let cancelled = false;
    let frameId = 0;
    let handLandmarker: HandLandmarker | null = null;
    let lastVideoTime = -1;
    let lastDetectionTime = 0;
    const inputVideo = inputVideoRef.current;
    inputVideo.srcObject = cameraStream;
    async function startHandTracking() {
      try {
        await inputVideo.play();
        const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm');
        if (cancelled) return;
        const handTrackingOptions = {
          runningMode: 'VIDEO' as const,
          numHands: 1,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        };
        try {
          handLandmarker = await HandLandmarker.createFromOptions(vision, {
            ...handTrackingOptions,
            baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task', delegate: 'GPU' },
          });
        } catch {
          handLandmarker = await HandLandmarker.createFromOptions(vision, {
            ...handTrackingOptions,
            baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task', delegate: 'CPU' },
          });
        }
        const detectHands = () => {
          if (cancelled || !handLandmarker) return;
          const now = performance.now();
          if (inputVideo.readyState >= 2 && inputVideo.currentTime !== lastVideoTime && now - lastDetectionTime >= 50) {
            lastVideoTime = inputVideo.currentTime;
            lastDetectionTime = now;
            const landmarks = handLandmarker.detectForVideo(inputVideo, now).landmarks[0];
            if (landmarks && isVictorySign(landmarks) && countdownRef.current === null && !captureInProgressRef.current) {
              if (victoryStartRef.current === null) victoryStartRef.current = now;
              setVictoryHeld(true);
              if (now - victoryStartRef.current >= 1000 && !captureInProgressRef.current) {
                victoryStartRef.current = null;
                setVictoryHeld(false);
                // Update the ref immediately so the next camera frame cannot restore
                // the Hold indicator while React is rendering the countdown.
                countdownRef.current = 3;
                setCountdown(3);
              }
            } else if (countdownRef.current === null) {
              victoryStartRef.current = null;
              setVictoryHeld(false);
            }
          }
          frameId = requestAnimationFrame(detectHands);
        };
        frameId = requestAnimationFrame(detectHands);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? `Hand tracking unavailable: ${reason.message}` : 'Hand tracking is unavailable.');
      }
    }
    void startHandTracking();
    return () => { cancelled = true; cancelAnimationFrame(frameId); handLandmarker?.close(); inputVideo.srcObject = null; };
  }, [cameraStream]);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown === 0) { countdownRef.current = null; setCountdown(null); void createAndShareCapture(); return; }
    const timer = window.setTimeout(() => setCountdown((value) => value === null ? null : value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown, createAndShareCapture]);

  useEffect(() => {
    if (!qrCode) return;
    if (qrCountdown <= 0) { setQrCode(''); return; }
    const timer = window.setTimeout(() => setQrCountdown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [qrCode, qrCountdown]);

  const unmuteLens = () => {
    // This must run from a click/tap because browsers block unprompted audio playback.
    sessionRef.current?.unmute();
    setNeedsUnmute(false);
  };
  return (
    <main className="camera-app">
      <canvas ref={canvasRef} className="camera-preview" />
      <video ref={inputVideoRef} className="hand-tracking-video" playsInline muted />
      {needsUnmute && <button className="lens-unmute" onClick={unmuteLens}>Tap to enable Lens sound</button>}
      {error && <div className="camera-error"><p>{error}</p><button onClick={() => setError('')}>Dismiss</button></div>}
      {lensLoading && <div className="lens-loading" role="status" aria-label="Loading Lens"><span /></div>}
      {victoryHeld && <div className="victory-indicator">✌️ Hold...</div>}
      {countdown !== null && <div className="capture-countdown">{countdown || '📸'}</div>}
      {qrCode && <aside className="qr-panel" aria-label="Capture QR code"><p>Scan to download</p><img src={qrCode} alt="QR code for your captured image" /><span>Closing in {qrCountdown}s</span></aside>}

    </main>
  );
}
