import "@testing-library/jest-dom";

const NodeUint8Array = Object.getPrototypeOf(Buffer.prototype).constructor;
if (global.Uint8Array !== NodeUint8Array) {
  global.Uint8Array = NodeUint8Array;
}
