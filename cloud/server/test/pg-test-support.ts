import type { Pool } from "pg";

/**
 * 测试收尾时先 pool.end() 再 DROP DATABASE ... WITH (FORCE)。pg 的连接池在连接真正断开前就会让 end() 返回，
 * 这时被强制终止的连接（57P01）已经没有错误监听，会变成未处理错误，让整个测试文件判为失败。
 * 给池里的每条连接挂一个错误监听；查询本身的错误仍然经 Promise 返回，不受影响。
 */
export function ignoreTerminatedConnections(pool: Pool): Pool {
  pool.on("error", () => undefined);
  pool.on("connect", (client) => {
    client.on("error", () => undefined);
  });
  return pool;
}
