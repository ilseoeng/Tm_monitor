const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Firebase Admin 설정 (Cloud Run 환경에서는 자동으로 인증 정보를 찾습니다)
admin.initializeApp();
const db = admin.firestore();

// Paddle 설정은 환경 변수에서 가져옵니다
const PADDLE_API_KEY = process.env.PADDLE_API_KEY;
const PADDLE_BASE_URL = process.env.PADDLE_SANDBOX === 'true'
    ? 'https://sandbox-api.paddle.com'
    : 'https://api.paddle.com';

app.post('/refund', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).send('Unauthorized: No token provided');
        }

        const idToken = authHeader.split('Bearer ')[1];

        // 관리자 권한 확인 (Firebase ID Token 검증)
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        console.log('Admin verified:', decodedToken.email);

        const { transaction_id, amount, minutes, serial_code } = req.body;

        if (!transaction_id || !serial_code) {
            return res.status(400).send('Missing required fields');
        }

        // Paddle Billing API: type='full'은 전체 거래 환불이므로 items 배열이 필요 없습니다.
        // (items 배열은 type='partial'일 때만 사용)
        console.log(`Processing full refund for transaction: ${transaction_id}`);

        const paddleResponse = await axios.post(`${PADDLE_BASE_URL}/adjustments`, {
            action: 'refund',
            transaction_id: transaction_id,
            reason: 'Admin refund from dashboard',
            type: 'full'
        }, {
            headers: {
                'Authorization': `Bearer ${PADDLE_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (paddleResponse.status !== 201) {
            throw new Error(`Paddle refund failed with status ${paddleResponse.status}`);
        }

        console.log('Paddle full refund created successfully for:', transaction_id);

        // 2. Firestore 데이터 업데이트
        const secondsToSubtract = parseInt(minutes) * 60;

        await db.runTransaction(async (t) => {
            const devicesRef = db.collection('devices');
            const deviceQuery = await devicesRef.where('serial_code', '==', serial_code).limit(1).get();

            if (!deviceQuery.empty) {
                const deviceDoc = deviceQuery.docs[0];
                const currentSeconds = deviceDoc.data().remaining_seconds || 0;
                t.update(deviceDoc.ref, {
                    remaining_seconds: Math.max(0, currentSeconds - secondsToSubtract)
                });
            }

            const logsRef = db.collection('payment_logs');
            const logQuery = await logsRef.where('transaction_id', '==', transaction_id).limit(1).get();

            if (!logQuery.empty) {
                t.update(logQuery.docs[0].ref, {
                    status: 'refunded',
                    refund_amount: amount,
                    refund_timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
            }
        });

        res.status(200).json({ success: true, message: 'Refund adjustment created successfully' });

    } catch (error) {
        const errorDetail = error.response?.data || error.message;
        console.error('Refund error details:', JSON.stringify(errorDetail, null, 2));
        res.status(500).json({
            success: false,
            error: error.response?.data?.error?.detail || error.message,
            raw_error: errorDetail
        });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
