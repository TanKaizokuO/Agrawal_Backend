export interface VerifiedPhoneToken {
  readonly uid: string;
  readonly phoneE164: string;
  readonly authTime: Date;
  readonly signInProvider: "phone";
}

export interface PhoneTokenVerifier {
  verifyIdToken(idToken: string, checkRevoked: true): Promise<VerifiedPhoneToken>;
}

export interface PushMessage {
  readonly topic: string;
  readonly subjectId: string;
  readonly title: string;
  readonly body: string;
  readonly data: Readonly<Record<string, string>>;
}

export interface PushSender {
  send(memberIds: readonly string[], message: PushMessage): Promise<Readonly<Record<string, number>>>;
}

export interface PaymentOrder {
  readonly providerOrderId: string;
  readonly amountPaise: number;
  readonly currency: "INR";
}

export type PaymentProviderStatus =
  | "created"
  | "authorized"
  | "captured"
  | "failed"
  | "refunded"
  | (string & {});

/**
 * The only provider payment shape that crosses into a module. It deliberately
 * contains only fields Razorpay returns on a fetched payment/webhook entity.
 */
export interface PaymentProviderPayment {
  readonly id: string;
  readonly orderId: string | null;
  readonly status: PaymentProviderStatus;
  readonly amountPaise: number | null;
  readonly method: string | null;
  readonly vpa: string | null;
  readonly cardId: string | null;
  readonly cardLast4: string | null;
  readonly errorDescription: string | null;
}

export interface PaymentRefund {
  readonly providerRefundId: string;
  readonly status: "pending" | "processed" | "failed" | (string & {});
}

export interface PaymentGateway {
  createOrder(input: {
    readonly amountPaise: number;
    readonly currency: "INR";
    readonly receipt: string;
    readonly notes: Readonly<Record<string, string>>;
  }): Promise<PaymentOrder>;
  findOrderByReceipt(receipt: string): Promise<PaymentOrder | null>;
  fetchPayment(providerPaymentId: string): Promise<PaymentProviderPayment>;
  fetchOrderPayments(providerOrderId: string): Promise<readonly PaymentProviderPayment[]>;
  capture(input: {
    readonly providerPaymentId: string;
    readonly amountPaise: number;
  }): Promise<PaymentProviderPayment>;
  refund(input: {
    readonly providerPaymentId: string;
    readonly amountPaise: number;
    readonly speed: "normal";
    readonly notes: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
  }): Promise<PaymentRefund>;
  fetchRefund(providerRefundId: string): Promise<PaymentRefund>;
}

export interface ObjectStore {
  put(input: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: string;
  }): Promise<void>;
  presignGet(key: string, ttlSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
}

export interface ImageScreener {
  screen(input: { readonly body: Uint8Array; readonly contentType: string }): Promise<
    "ACCEPTED" | "REJECTED"
  >;
}

export interface Romanizer {
  romanize(devanagari: string): Promise<string>;
}

export interface PincodePlace {
  readonly city: string;
  readonly cityKey: string;
  readonly district: string | null;
  readonly state: string;
}

export interface PincodeDirectory {
  lookup(pincode: string): Promise<PincodePlace | null>;
}
