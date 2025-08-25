// 将纯文本转为 html（<pre> 包裹并转义）
function textToHtml(text: string): string {
  const esc = (s: string) => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!))
  return `<pre>${esc(text)}</pre>`
}
import { Context, Schema, Session, Logger } from 'koishi'
import OneBotBot, { OneBot } from 'koishi-plugin-adapter-onebot'
import type { MailBot } from '@koishijs/plugin-adapter-mail'


export const name = 'qq-group-mail-validator'


export interface Config {
  mailBotName: string
  mailFrom: string
  mailSubject?: string
  codeExpire?: number // 单位秒
  groupMailSuffixes?: Record<string, string[]> // 每个群允许的邮箱后缀白名单
}

export const Config: Schema<Config> = Schema.object({
  mailBotName: Schema.string().description('邮件适配器的 bot 名称（如 mail:default）'),
  mailFrom: Schema.string().description('发件人邮箱地址'),
  mailSubject: Schema.string().description('邮件主题').default('QQ 群入群验证码'),
  codeExpire: Schema.number().description('验证码有效期（秒）').default(600),
  groupMailSuffixes: Schema.dict(Schema.array(String)).description('每个群允许的邮箱后缀白名单'),
})

const logger = new Logger('qq-group-mail-validator')



// 内存存储验证码和申请信息
const codeStore = new Map<string, {
  code: string
  email: string
  expire: number
  groupId: string
  userId: string
  flag: string
  timer?: NodeJS.Timeout
}>()

function validateEmail(email: string) {
  return /^[\w.-]+@[\w.-]+\.[a-zA-Z]{2,}$/.test(email)
}

function generateCode() {
  return Math.random().toString().slice(2, 8)
}

async function sendVerificationCode(ctx: Context, config: Config, comment, userId, groupId, flag, email) {
  const code = generateCode()
  const expire = Date.now() + (config.codeExpire || 600) * 1000
  // 设置定时器，到期时删除该userId的数据
  const timer = setTimeout(() => {
    codeStore.delete(userId);
    logger.info(`验证码过期，已删除用户 ${userId} 的数据`);
  }, (config.codeExpire || 600) * 1000);
  codeStore.set(userId, { code, email, expire, groupId, userId, flag, timer });

  const mailBot = Object.values(ctx.bots).find(bot => bot.platform === 'mail') as MailBot
  if (!mailBot) {
      logger.error('未找到邮件适配器，请检查 mailBotName 配置');
      return;
    }
  await mailBot.internal.send({
      to: email, // 收件人
      subject: config.mailSubject || 'QQ 群入群验证码',
      html: `您的入群验证码为：${code}，有效期${config.codeExpire || 600}秒。使用方法，重新发送入群申请，申请内容为 “validate ${code}”。`
    });
  logger.info('发送验证码' , code, '成功');
}

export function apply(ctx: Context, config: Config) {
ctx.command('test', '测试命令')
  .action(async ({ session }) => {
    logger.error(config.groupMailSuffixes?.[925728476])
    await session.send('测试成功');
  });

  // 监听入群申请（onebot）
  ctx.on('guild-member-request', async (session: Session) => {
    if (session.platform !== 'onebot') return
    const { comment, user_id, group_id, flag, sub_type } = session.event._data as any
    const msg = session.event.message.elements[0].attrs.content || "";
    // 校验邮箱格式
    if (validateEmail(msg)) {
      // 校验邮箱后缀白名单
      const allowedSuffixes = config.groupMailSuffixes?.[group_id] || [];
      logger.info(allowedSuffixes, group_id);
      if (allowedSuffixes.length && !allowedSuffixes.some(suffix => msg.endsWith(suffix))) {
        logger.info('邮箱后缀不在白名单', { group_id, msg, allowedSuffixes });
        await session.bot.internal.setGroupAddRequest(flag, sub_type, false, '邮箱后缀不允许');
        return;
      }
      const info = codeStore.get(user_id);
      if (info) info.timer && clearTimeout(info.timer);

      logger.info('收到入群申请', { user_id, group_id, msg }, '发送验证码', session.event);
      logger.error(session)
      sendVerificationCode(ctx, config, comment, user_id, group_id, flag, msg);
      await session.bot.internal.setGroupAddRequest(flag, sub_type, false, `已向您的邮箱 ${msg.slice(0,5)} 发送验证码，请查收。`);
      return;
    };
    if (msg.startsWith("validate ")) {
      const code = msg.split(' ')[1]; // Extract the code from the message
      const info = codeStore.get(user_id);
      if (!info) return '请先获取验证码。';
      if (Date.now() > info.expire) {
        codeStore.delete(user_id);
        await session.bot.handleGuildRequest(flag, false, `'验证码已过期，请重新发送入群申请获取。'`);
        return '验证码已过期，请重新获取。';
      }
      if (info.code !== code) {
        await session.bot.internal.setGroupAddRequest(flag, sub_type, false, '验证码错误。');
        return
      }
      await session.bot.internal.setGroupAddRequest(flag, sub_type, true);
      info.timer && clearTimeout(info.timer);
      codeStore.delete(user_id);
      return '验证成功，已同意入群申请。';
    }

  })

}
