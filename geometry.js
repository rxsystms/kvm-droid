export function fitScreen(availableWidth, availableHeight, width, height) {
  const scale = Math.max(0, Math.min(availableWidth / width, availableHeight / height));
  return { width: width * scale, height: height * scale };
}

export function screenPoint(clientX, clientY, rect, width, height) {
  if (rect.width <= 0 || rect.height <= 0 || width <= 0 || height <= 0) return null;
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || y < 0 || x > 1 || y > 1) return null;
  return {
    x: Math.min(width - 1, Math.floor(x * width)),
    y: Math.min(height - 1, Math.floor(y * height)),
  };
}

export function gestureAction(start, end, elapsed, distance) {
  if (distance < 8 && elapsed < 500) return { type: 'tap', x: start.x, y: start.y };
  return {
    type: 'swipe', x: start.x, y: start.y, endX: end.x, endY: end.y,
    duration: Math.round(Math.max(100, Math.min(2000, elapsed))),
  };
}
