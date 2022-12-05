import { gzip, gunzip, InputType } from 'node:zlib';

export async function compress(data: InputType): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(data, (error, buffer) => {
      if (error) {
        reject(error);
      } else {
        resolve(buffer);
      }
    });
  });
}

export async function decompress(buffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gunzip(buffer, (error, data) => {
      if (error) {
        reject(error);
      } else {
        resolve(data);
      }
    });
  });
}
