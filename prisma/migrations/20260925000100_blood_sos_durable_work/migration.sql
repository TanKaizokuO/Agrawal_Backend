ALTER TABLE "blood_sos_request"
  ALTER COLUMN "current_tier" SET DEFAULT 0;

UPDATE "blood_sos_request" AS request
   SET "current_tier" = 0
 WHERE request."status" = 'ACTIVE'
   AND request."current_tier" = 1
   AND NOT EXISTS (
     SELECT 1
       FROM "blood_sos_alert" AS alert
      WHERE alert."request_id" = request."id"
   );
