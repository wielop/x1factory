declare module "buffer-layout" {
  export class Layout<T> {
    span: number;
    constructor(span?: number, property?: string);
    decode(b: any, offset?: number): T;
    encode(src: T, b: any, offset?: number): number;
    getSpan(b: any, offset?: number): number;
  }
  export const blob: any;
  export const struct: any;
  export const u8: any;
}
