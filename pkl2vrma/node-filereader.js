/** THREE.GLTFExporter binary path uses FileReader; Node 24 has Blob but not FileReader. */
if (typeof globalThis.FileReader === "undefined") {
  globalThis.FileReader = class FileReader {
    result = null;
    onloadend = null;
    readAsArrayBuffer(blob) {
      Promise.resolve(blob.arrayBuffer()).then((buf) => {
        this.result = buf;
        this.onloadend?.();
      });
    }
  };
}
