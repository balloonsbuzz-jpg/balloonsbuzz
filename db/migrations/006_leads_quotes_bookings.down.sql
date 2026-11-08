DROP TABLE IF EXISTS booking_status_history;
DROP FUNCTION IF EXISTS log_booking_status_change() CASCADE;
DROP TABLE IF EXISTS booking_payments;
DROP FUNCTION IF EXISTS sync_booking_paid_amount() CASCADE;
DROP TABLE IF EXISTS bookings;
DROP SEQUENCE IF EXISTS booking_code_seq;
DROP TABLE IF EXISTS quote_events;
DROP TABLE IF EXISTS quotes;
DROP TABLE IF EXISTS leads;
