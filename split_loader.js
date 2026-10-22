
(async () => {
  const PART_SIZE = 20 * 1024 * 1024;

  /**
   * Load a file stored as:
   *   filename.part000
   *   filename.part001
   *   filename.part002
   *
   * Set the original file size so the loader knows when to stop.
   */
  async function loadSplitFile(url, totalSize) {
    const parts = [];
    let loaded = 0;
    let index = 0;

    while (loaded < totalSize) {
      const partUrl = `${url}.part${String(index).padStart(3, "0")}`;
      const response = await fetch(partUrl);

      if (!response.ok) {
        throw new Error(`Failed to load ${partUrl}: HTTP ${response.status}`);
      }

      const part = await response.arrayBuffer();
      const expectedSize = Math.min(PART_SIZE, totalSize - loaded);

      if (part.byteLength !== expectedSize) {
        throw new Error(
          `Invalid part ${index}: expected ${expectedSize} bytes, got ${part.byteLength}`
        );
      }

      parts.push(part);
      loaded += part.byteLength;
      index++;

      console.log(`Loaded ${loaded}/${totalSize} bytes`);
    }

    return new Blob(parts);
  }

  // Example usage:
  // Replace the URL and original file size with your actual values.
  window.loadSplitFile = loadSplitFile;
})();
