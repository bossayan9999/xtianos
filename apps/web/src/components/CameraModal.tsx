import { useEffect, useRef, useState } from 'react'

interface Props {
  onCapture: (dataUrl: string) => void
  onClose: () => void
}

/** Live camera modal — snapshot becomes an attached image for vision models. */
export function CameraModal({ onCapture, onClose }: Props): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stream: MediaStream | null = null
    navigator.mediaDevices
      .getUserMedia({ video: { width: 1280, height: 720 }, audio: false })
      .then((s) => {
        stream = s
        if (videoRef.current) videoRef.current.srcObject = s
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    return () => stream?.getTracks().forEach((t) => t.stop())
  }, [])

  const shoot = (): void => {
    const video = videoRef.current
    if (!video) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth || 1280
    canvas.height = video.videoHeight || 720
    canvas.getContext('2d')?.drawImage(video, 0, 0)
    onCapture(canvas.toDataURL('image/jpeg', 0.85))
    onClose()
  }

  return (
    <div className="voice-modal-backdrop" onClick={onClose}>
      <div className="voice-modal camera-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>📷 Camera</h3>
          <button type="button" className="close" onClick={onClose}>
            ✕
          </button>
        </header>
        {error ? <p className="voice-error">{error}</p> : <video ref={videoRef} autoPlay playsInline muted />}
        <footer>
          <button type="button" className="primary" disabled={!!error} onClick={shoot}>
            📸 Snapshot & attach
          </button>
        </footer>
      </div>
    </div>
  )
}
