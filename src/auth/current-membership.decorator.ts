import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { MembershipRequest } from './membership.guard.js';

export const CurrentMembership = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<MembershipRequest>().membership,
);
