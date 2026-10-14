import { BadRequestException } from '@nestjs/common';

export type DeliverySignature = Array<Array<{ x: number; y: number }>>;

// Same normalized stroke format and meaningful-signature checks as agreements.
export function customerDeliverySignature(value: unknown): DeliverySignature {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100)
    throw new BadRequestException('Draw the recipient signature.');
  let count = 0, distance = 0;
  const result: DeliverySignature = [];
  for (const stroke of value) {
    if (!Array.isArray(stroke) || stroke.length < 1 || stroke.length > 3000)
      throw new BadRequestException('Invalid recipient signature.');
    const points: DeliverySignature[number] = [];
    for (const point of stroke) {
      if (!point || typeof point !== 'object' ||
          !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
          point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)
        throw new BadRequestException('Invalid recipient signature.');
      const previous = points[points.length - 1];
      if (previous) distance += Math.hypot(point.x - previous.x, point.y - previous.y);
      points.push({ x: point.x, y: point.y });
      if (++count > 5000) throw new BadRequestException('Invalid recipient signature.');
    }
    result.push(points);
  }
  if (count < 5 || distance < 0.08)
    throw new BadRequestException('Draw the recipient signature before continuing.');
  return result;
}
