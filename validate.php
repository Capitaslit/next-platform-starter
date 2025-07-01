<?php

header('Access-Control-Allow-Origin: *');
header('Content-Type: application/json');
header('Access-Control-Allow-Methods: POST');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit();
}

require_once '../vendor/autoload.php';

// Ensure the input is valid JSON before decoding
$rawInput = file_get_contents('php://input');
if (!isValidJson($rawInput)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid JSON input']);
    exit();
}

$input = json_decode($rawInput, true);
$payment_method_id = $input['payment_method_id'] ?? null;
$secret_key = $input['secret_key'] ?? null;

if (!$payment_method_id || !$secret_key) {
    http_response_code(400);
    echo json_encode(['error' => 'Missing required parameters']);
    exit();
}

// Helper function to validate JSON
function isValidJson($string) {
    json_decode($string);
    return json_last_error() === JSON_ERROR_NONE;
}

try {
    \Stripe\Stripe::setApiKey($secret_key);

    // Create a SetupIntent and confirm it with the payment method
    $setup_intent = \Stripe\SetupIntent::create([
        'payment_method' => $payment_method_id,
        'confirm' => true,
        'usage' => 'off_session',
        'return_url' => 'https://crdpro.cc',
        'automatic_payment_methods' => [
            'enabled' => true,
            'allow_redirects' => 'never'
        ]
    ]);

    // Check the status
    $status = $setup_intent->status;
    $success = in_array($status, ['succeeded', 'requires_action', 'processing']);

    // If 3D Secure authentication is required
    if ($status === 'requires_action' || $status === 'requires_source_action') {
        echo json_encode([
            'success' => false,
            'status' => $status,
            'setup_intent' => $setup_intent->id,
            'client_secret' => $setup_intent->client_secret,
            'requires_action' => true
        ]);
        exit();
    }

    echo json_encode([
        'success' => $success,
        'status' => $status,
        'setup_intent' => $setup_intent->id
    ]);
} catch (\Exception $e) {
    http_response_code(400);
    echo json_encode([
        'error' => $e->getMessage(),
        'type' => get_class($e)
    ]);
}

[code]