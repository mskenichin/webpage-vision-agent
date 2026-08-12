export interface FrameSize {
  width: number;
  height: number;
}

export interface DisplayRect extends FrameSize {
  left: number;
  top: number;
}

export function displayPointToFrame(
  clientX: number,
  clientY: number,
  display: DisplayRect,
  frame: FrameSize,
) {
  if (display.width <= 0 || display.height <= 0 || frame.width <= 0 || frame.height <= 0) return null;
  const scale = Math.min(display.width / frame.width, display.height / frame.height);
  const renderedWidth = frame.width * scale;
  const renderedHeight = frame.height * scale;
  const renderedLeft = display.left + (display.width - renderedWidth) / 2;
  const renderedTop = display.top + (display.height - renderedHeight) / 2;
  const localX = clientX - renderedLeft;
  const localY = clientY - renderedTop;
  if (localX < 0 || localY < 0 || localX > renderedWidth || localY > renderedHeight) return null;
  return {
    x: Math.min(frame.width, Math.max(0, localX / scale)),
    y: Math.min(frame.height, Math.max(0, localY / scale)),
  };
}