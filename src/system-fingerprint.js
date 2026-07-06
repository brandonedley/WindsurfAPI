import { createHash } from 'crypto';

// O9: 合成的 system_fingerprint。我们是翻译代理,上游 Windsurf/Devin 私有协议
// 不返回任何后端配置指纹(无真实熵源),所以无法转发真值。这里发一个**稳定的
// 合成值**,只由回显给客户端的 model 名派生:同 model 两次请求得同一 fp
// (客户端用 system_fingerprint 做 run-to-run 一致性判断),不同 model 得不同 fp。
// 这是诚实的——广告的是「代理配置」而非伪造的后端 seed,绝不掺时间戳/随机熵。
// 形状对齐 OpenAI:`fp_` + 10 位小写十六进制(例 fp_44709d6fcb)。
// 非 PAID 标定:没有「真值」可发现,纯代码即终态。
const FP_SALT = 'windsurfapi-proxy-v1';

export function systemFingerprint(model) {
  const h = createHash('sha256')
    .update(FP_SALT)
    .update('\0')
    .update(String(model || 'unknown'))
    .digest('hex');
  return `fp_${h.slice(0, 10)}`;
}
