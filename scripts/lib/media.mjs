import { imageSizeFromFile } from 'image-size/fromFile';

export async function imageDimensions(file) {
  try {
    const { width, height, orientation } = await imageSizeFromFile(file);
    if (![width, height].every(value => Number.isFinite(value) && value > 0)) return undefined;
    // Browsers apply EXIF rotation when displaying JPEGs.
    return orientation >= 5 && orientation <= 8
      ? { width: height, height: width }
      : { width, height };
  } catch {
    // Some valid SVGs have no intrinsic size. Let the browser size these naturally.
    return undefined;
  }
}
