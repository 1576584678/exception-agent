import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError } from '../errors.js';
import type { AuthService } from '../services/auth.js';
import { authenticate } from '../middleware/auth.js';

const loginSchema = z.object({
  employeeId: z.string().min(1),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance, auth: AuthService): Promise<void> {
  app.post('/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError('INVALID_BODY', '工号与密码必填');
    const { token, user } = await auth.login(parsed.data.employeeId, parsed.data.password);
    return reply.send({
      token,
      user: { id: user.id, name: user.name, role: user.role, employeeId: user.employeeId },
    });
  });

  app.get('/me', { preHandler: [authenticate] }, async (req) => req.user);
}
