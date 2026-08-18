class ApiError extends Error {
    statusCode: number;
    data: unknown;

    constructor(statusCode: number, message: string, data: unknown = null) {
        super(message);

        this.statusCode = statusCode;
        this.message = message;
        this.data = data;
    }
}

export default ApiError;
