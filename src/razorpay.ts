import Razorpay from "razorpay"
import type { AppEnv } from "./env.js"

type RazorpayPaymentEntity = {
  id: string
  status?: string
}

type RazorpayPaymentList = {
  items?: RazorpayPaymentEntity[]
}

export function createRazorpay(env: AppEnv) {
  return new Razorpay({
    key_id: env.razorpayKeyId,
    key_secret: env.razorpayKeySecret,
  })
}

export async function listOrderPayments(
  razorpay: ReturnType<typeof createRazorpay>,
  orderId: string,
): Promise<RazorpayPaymentEntity[]> {
  const result = (await razorpay.orders.fetchPayments(orderId)) as RazorpayPaymentList
  return result.items ?? []
}

export function findCapturedPayment(payments: RazorpayPaymentEntity[]) {
  return payments.find((payment) => payment.status === "captured")
}

export function findFailedPayment(payments: RazorpayPaymentEntity[]) {
  return payments.find((payment) => payment.status === "failed")
}

