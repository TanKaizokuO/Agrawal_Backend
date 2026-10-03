import { Prisma } from "../generated/prisma/client.js";
import type { ErrorRequestHandler } from "express";
import { z } from "zod";

export const ERROR_MESSAGES = {
  VALIDATION_FAILED: { en: "The request is invalid.", hi: "अनुरोध अमान्य है।" },
  UNAUTHENTICATED: { en: "Sign-in is required.", hi: "साइन-इन आवश्यक है।" },
  FORBIDDEN: { en: "You are not allowed to do that.", hi: "आपको यह करने की अनुमति नहीं है।" },
  NOT_FOUND: { en: "The requested resource was not found.", hi: "मांगा गया संसाधन नहीं मिला।" },
  CONFLICT: { en: "The request conflicts with existing data.", hi: "अनुरोध मौजूदा डेटा से टकराता है।" },
  RATE_LIMITED: { en: "Too many requests. Try again later.", hi: "बहुत अधिक अनुरोध। बाद में फिर प्रयास करें।" },
  IDEMPOTENCY_KEY_REQUIRED: {
    en: "This operation requires an Idempotency-Key header.",
    hi: "इस कार्य के लिए Idempotency-Key हेडर आवश्यक है।",
  },
  IDEMPOTENCY_KEY_INVALID: {
    en: "The Idempotency-Key header must be a UUID.",
    hi: "Idempotency-Key हेडर UUID होना चाहिए।",
  },
  IDEMPOTENCY_KEY_REUSED: {
    en: "The idempotency key was already used for a different request.",
    hi: "Idempotency-Key पहले किसी अलग अनुरोध में उपयोग हो चुका है।",
  },
  INTERNAL: { en: "An unexpected error occurred.", hi: "एक अनपेक्षित त्रुटि हुई।" },
  PAYLOAD_TOO_LARGE: { en: "The request body is too large.", hi: "अनुरोध का मुख्य भाग बहुत बड़ा है।" },
  UPSTREAM_UNAVAILABLE: {
    en: "A required upstream service is unavailable.",
    hi: "आवश्यक बाहरी सेवा उपलब्ध नहीं है।",
  },
  UNSUPPORTED_MEDIA_TYPE: {
    en: "The request body must use JSON.",
    hi: "अनुरोध का मुख्य भाग JSON होना चाहिए।",
  },
  OTP_INVALID: {
    en: "The OTP is invalid or expired.",
    hi: "OTP अमान्य या समाप्त हो गया है।",
  },
  OTP_ATTEMPTS_EXCEEDED: {
    en: "Too many incorrect OTP attempts. Please request a new code.",
    hi: "बहुत अधिक गलत OTP प्रयास। कृपया नया कोड मांगें।",
  },
  OTP_DELIVERY_FAILED: {
    en: "Failed to deliver OTP via SMS.",
    hi: "SMS द्वारा OTP भेजने में विफल।",
  },
  PHONE_BELONGS_TO_ARCHIVED_MEMBER: {
    en: "This phone belongs to an archived Member.",
    hi: "यह फ़ोन किसी संग्रहीत सदस्य का है।",
  },
  SESSION_EXPIRED: { en: "Your session has expired.", hi: "आपका सत्र समाप्त हो गया है।" },
  PAYMENT_NOT_FOUND: { en: "The payment was not found.", hi: "भुगतान नहीं मिला।" },
  PAYMENT_SIGNATURE_INVALID: {
    en: "The payment signature is invalid.",
    hi: "भुगतान हस्ताक्षर अमान्य है।",
  },
  PAYMENT_ALREADY_CAPTURED: {
    en: "The payment has already been captured.",
    hi: "भुगतान पहले ही कैप्चर हो चुका है।",
  },
  REGISTRATION_NOT_FOUND: { en: "The registration was not found.", hi: "पंजीकरण नहीं मिला।" },
  REGISTRATION_WRONG_STATE: { en: "The registration is not in the required state.", hi: "पंजीकरण आवश्यक स्थिति में नहीं है।" },
  REGISTRATION_NOT_PAID: { en: "The registration payment is not captured.", hi: "पंजीकरण का भुगतान कैप्चर नहीं हुआ है।" },
  DUPLICATE_HEAD: { en: "This payment identity is already linked to a Family head.", hi: "यह भुगतान पहचान पहले से किसी परिवार प्रमुख से जुड़ी है।" },
  FAMILY_NOT_FOUND: { en: "The Family was not found.", hi: "परिवार नहीं मिला।" },
  FAMILY_NOT_ACCEPTING_JOINS: { en: "This Family is not accepting joins.", hi: "यह परिवार नए सदस्य स्वीकार नहीं कर रहा है।" },
  NOT_ADULT: { en: "The Member must be an adult.", hi: "सदस्य की आयु वयस्क होनी चाहिए।" },
  GOTRA_NOT_ALLOWED_FOR_JOIN: { en: "Gotra cannot be selected when joining a Family.", hi: "परिवार में शामिल होते समय गोत्र नहीं चुना जा सकता।" },
  GOTRA_REQUIRED: { en: "A Gotra is required for a founding registration.", hi: "नए परिवार के लिए गोत्र आवश्यक है।" },
  PHONE_ALREADY_REGISTERED: { en: "This phone is already registered.", hi: "यह फ़ोन पहले से पंजीकृत है।" },
  NOMINEE_NOT_IN_FAMILY: { en: "The nominee must be an active Member of your Family.", hi: "नामांकित व्यक्ति आपके परिवार का सक्रिय सदस्य होना चाहिए।" },
  NOMINEE_IS_SELF: { en: "You cannot nominate yourself.", hi: "आप स्वयं को नामांकित नहीं कर सकते।" },
  REAUTH_REQUIRED: { en: "Recent re-authentication is required.", hi: "हाल का पुनः प्रमाणीकरण आवश्यक है।" },
  MEMBER_NOT_FOUND: { en: "The Member was not found.", hi: "सदस्य नहीं मिला।" },
  NOT_HEAD: { en: "Only the Family head can perform this action.", hi: "यह कार्य केवल परिवार प्रमुख कर सकता है।" },
  IMAGE_TYPE_UNSUPPORTED: { en: "This image type is not supported.", hi: "यह छवि प्रकार समर्थित नहीं है।" },
  IMAGE_TOO_LARGE: { en: "The image is too large.", hi: "छवि बहुत बड़ी है।" },
  IMAGE_DIMENSIONS_INVALID: { en: "The image dimensions are invalid.", hi: "छवि के आयाम अमान्य हैं।" },
  IMAGE_REFUSED: { en: "The image requires Officer review and was not accepted.", hi: "छवि को अधिकारी की समीक्षा चाहिए और इसे स्वीकार नहीं किया गया।" },
  IMAGE_NOT_FOUND: { en: "The image was not found.", hi: "छवि नहीं मिली।" },
  IMAGE_NOT_OWNED: { en: "You do not own this image.", hi: "यह छवि आपके स्वामित्व में नहीं है।" },
  FLAG_NOT_FOUND: { en: "The Officer flag was not found.", hi: "अधिकारी फ़्लैग नहीं मिला।" },
  FLAG_ALREADY_RESOLVED: { en: "The Officer flag is already resolved.", hi: "अधिकारी फ़्लैग पहले ही हल हो चुका है।" },
  NOMINEE_READ_NOT_PERMITTED: { en: "This nominee read is not permitted.", hi: "नामांकित व्यक्ति की जानकारी पढ़ने की अनुमति नहीं है।" },
  POSTING_CAP_REACHED: { en: "Your daily posting limit has been reached.", hi: "आपकी दैनिक पोस्ट सीमा पूरी हो गई है।" },
  POSTING_SUSPENDED: { en: "Posting is suspended for this Member.", hi: "इस सदस्य की पोस्टिंग निलंबित है।" },
  NOTICE_CONTAINS_PHONE: { en: "The notice contains a personal phone number.", hi: "सूचना में व्यक्तिगत फ़ोन नंबर है।" },
  NOTICE_CONTAINS_BLOCKED_WORD: { en: "The notice contains blocked language.", hi: "सूचना में प्रतिबंधित शब्द हैं।" },
  CANNOT_REPORT_OWN: { en: "You cannot report your own notice.", hi: "आप अपनी सूचना की रिपोर्ट नहीं कर सकते।" },
  ALREADY_REPORTED: { en: "You have already reported this item.", hi: "आपने इस सामग्री की पहले ही रिपोर्ट की है।" },
  NOTICE_NOT_FOUND: { en: "The notice was not found.", hi: "सूचना नहीं मिली।" },
  LISTING_NOT_FOUND: { en: "The business listing was not found.", hi: "व्यवसाय सूची नहीं मिली।" },
  ARCHIVAL_REQUEST_NOT_FOUND: { en: "The archival request was not found.", hi: "संग्रह अनुरोध नहीं मिला।" },
  ARCHIVAL_REQUEST_ALREADY_RESOLVED: { en: "The archival request is already resolved.", hi: "संग्रह अनुरोध पहले ही हल हो चुका है।" },
  NOT_FAMILY_MEMBER: { en: "You are not a Member of this Family.", hi: "आप इस परिवार के सदस्य नहीं हैं।" },
  BOARD_NOT_OPEN: { en: "This notice board is not open.", hi: "यह सूचना बोर्ड खुला नहीं है।" },
  SOS_ALREADY_ACTIVE: { en: "You already have an active Blood SOS request.", hi: "आपका रक्त SOS अनुरोध पहले से सक्रिय है।" },
  SOS_NOT_FOUND: { en: "The Blood SOS request was not found.", hi: "रक्त SOS अनुरोध नहीं मिला।" },
  SOS_ALREADY_CLOSED: { en: "The Blood SOS request is already closed.", hi: "रक्त SOS अनुरोध पहले ही बंद है।" },
  SOS_NOT_REQUESTER: { en: "Only the requester can perform this action.", hi: "यह कार्य केवल अनुरोधकर्ता कर सकता है।" },
  SOS_NOT_ALERTED: { en: "You are not eligible to respond to this Blood SOS.", hi: "आपको इस रक्त SOS के लिए सूचित नहीं किया गया है।" },
  SOS_ALREADY_RESPONDED: { en: "You have already responded to this Blood SOS.", hi: "आपने इस रक्त SOS का पहले ही उत्तर दिया है।" },
  SOS_PLACE_UNAVAILABLE: { en: "The hospital location could not be determined.", hi: "अस्पताल का स्थान निर्धारित नहीं हो सका।" },
  GATE_DEVICE_NOT_FOR_EVENT: { en: "This gate device is not registered for the event.", hi: "यह गेट डिवाइस इस कार्यक्रम के लिए पंजीकृत नहीं है।" },
  EVENT_NOT_FOUND: { en: "The event was not found.", hi: "कार्यक्रम नहीं मिला।" },
  EVENT_NOT_ACTIVE: { en: "The event is not active.", hi: "कार्यक्रम सक्रिय नहीं है।" },
  EVENT_NOT_EDITABLE: { en: "This event can no longer be edited.", hi: "इस कार्यक्रम में अब बदलाव नहीं किया जा सकता।" },
  PASS_ALREADY_EXISTS: { en: "You already have a pass for this event.", hi: "इस कार्यक्रम के लिए आपका पास पहले से है।" },
  PASS_NOT_FOUND: { en: "The event pass was not found.", hi: "कार्यक्रम पास नहीं मिला।" },
  INVALID_EVENT_PASS: { en: "The event pass is invalid.", hi: "कार्यक्रम पास अमान्य है।" },
  INVALID_NOTIFICATION_PAYLOAD: { en: "The notification payload is invalid.", hi: "सूचना पेलोड अमान्य है।" },
  DEVICE_TOKEN_OWNERSHIP_CONFLICT: {
    en: "This device is already registered to another Member.",
    hi: "यह डिवाइस पहले से किसी अन्य सदस्य के लिए पंजीकृत है।",
  },
} as const;

export type KnownErrorCode = keyof typeof ERROR_MESSAGES;
export type ErrorCode = KnownErrorCode | (string & {});
export type SupportedLanguage = "en" | "hi";

type ErrorMessage = { readonly en: string; readonly hi: string };

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: unknown;
  readonly headers: Readonly<Record<string, string>> | undefined;

  constructor(
    code: ErrorCode,
    httpStatus: number,
    details?: unknown,
    headers?: Readonly<Record<string, string>>,
  ) {
    super(code);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
    this.headers = headers;
  }

  static rateLimited(retryAfterSeconds: number): AppError {
    const retryAfter = Math.max(1, Math.ceil(retryAfterSeconds));
    return new AppError(
      "RATE_LIMITED",
      429,
      { retryAfterSeconds: retryAfter },
      { "Retry-After": String(retryAfter) },
    );
  }
}

export interface ErrorLogger {
  error(bindings: Record<string, unknown>, message?: string): void;
}

function errorMessage(code: ErrorCode): ErrorMessage {
  if (Object.hasOwn(ERROR_MESSAGES, code)) {
    return ERROR_MESSAGES[code as KnownErrorCode];
  }
  return ERROR_MESSAGES.INTERNAL;
}

function languageFor(request: { get(name: string): string | undefined }): SupportedLanguage {
  const language = request.get("Accept-Language")?.split(",", 1)[0]?.trim().toLowerCase();
  return language === "hi" || language?.startsWith("hi-") ? "hi" : "en";
}

export function validationDetails(error: z.ZodError): { issues: Array<{ path: PropertyKey[]; message: string }> } {
  return {
    issues: error.issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
    })),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  ) ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002");
}

function bodyParserError(error: unknown): AppError | null {
  if (typeof error !== "object" || error === null || !("type" in error)) {
    return null;
  }
  if (error.type === "entity.parse.failed") {
    return new AppError("VALIDATION_FAILED", 400);
  }
  if (error.type === "entity.too.large") {
    return new AppError("PAYLOAD_TOO_LARGE", 413);
  }
  return null;
}

export function errorMiddleware(logger?: ErrorLogger): ErrorRequestHandler {
  return (error: unknown, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    const requestIdValue = request.id;
    const requestId =
      typeof requestIdValue === "string"
        ? requestIdValue
        : typeof requestIdValue === "number"
          ? String(requestIdValue)
          : "unknown";
    let appError: AppError;
    const parseError = bodyParserError(error);
    if (error instanceof AppError) {
      appError = error;
    } else if (error instanceof z.ZodError) {
      appError = new AppError("VALIDATION_FAILED", 400, validationDetails(error));
    } else if (parseError !== null) {
      appError = parseError;
    } else if (isUniqueViolation(error)) {
      appError = new AppError("CONFLICT", 409);
    } else {
      logger?.error({ err: error, requestId }, "Unhandled request error");
      appError = new AppError("INTERNAL", 500);
    }

    for (const [name, value] of Object.entries(appError.headers ?? {})) {
      response.setHeader(name, value);
    }

    const message = errorMessage(appError.code)[languageFor(request)];
    const body: {
      error: { code: ErrorCode; message: string; details?: unknown };
      requestId: string;
    } = {
      error: {
        code: appError.code,
        message,
      },
      requestId,
    };
    if (appError.details !== undefined) {
      body.error.details = appError.details;
    }
    response.status(appError.httpStatus).json(body);
  };
}
