/** Démarre la caméra et l'affiche dans l'élément vidéo donné. */
export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  return stream;
}

export function stopCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/** Capture l'image affichée par la vidéo en un JPEG, pour l'envoyer tel quel au serveur. */
export function captureJpeg(video: HTMLVideoElement, quality = 0.85): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('capture impossible'));
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('capture impossible'))),
      'image/jpeg',
      quality,
    );
  });
}
