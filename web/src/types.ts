export type ScanPage = {
  id: string;
  blob: Blob;
  /** Object URL for display; revoked when the page is removed. */
  url: string;
  rotation: 0 | 90 | 180 | 270;
  /** Physical size in 1/300 inch, carried through to the PDF page box. */
  widthUnits: number;
  heightUnits: number;
};
