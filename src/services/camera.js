// src/services/camera.js
// 코드 주석에 이모티콘은 사용하지 않습니다.
import { launchCamera } from 'react-native-image-picker';
import { Platform, PermissionsAndroid } from 'react-native';
import { BACKEND_HTTP_URL } from '../config/env';

async function ensurePermissions() {
  if (Platform.OS !== 'android') return;
  const cam = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA);
  if (cam !== PermissionsAndroid.RESULTS.GRANTED) {
    throw new Error('카메라 권한이 필요합니다.');
  }
}

export async function captureAndUpload(sessionId, prompt) {
  await ensurePermissions();

  const result = await launchCamera({
    mediaType: 'photo',
    includeBase64: true,
    saveToPhotos: false,
    quality: 0.9
  });

  if (result.didCancel) throw new Error('촬영이 취소되었습니다.');
  const asset = result.assets?.[0];
  if (!asset?.base64) throw new Error('이미지 캡처 실패');

  const form = new FormData();
  form.append('sessionId', sessionId);
  form.append('prompt', prompt || '이미지의 핵심 정보를 요약해줘.');
  form.append('images', {
    uri: asset.uri,
    type: asset.type || 'image/jpeg',
    name: asset.fileName || 'photo.jpg'
  });

  const res = await fetch(`${BACKEND_HTTP_URL}/api/vision/analyze`, {
    method: 'POST',
    headers: { 'Accept': 'application/json' },
    body: form
  });

  const json = await res.json();
  if (!json.ok) throw new Error(String(json.error || '업로드 실패'));
  return json.text;
}
