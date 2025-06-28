import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'secret';
const MONGO_URI = process.env.MONGO_URI || '';
const client = new MongoClient(MONGO_URI);

let transactionsCollection: any;

client.connect().then(() => {
  const db = client.db(); // uses the DB name from connection string
  transactionsCollection = db.collection('transactions');
  console.log('Connected to MongoDB');
  console.log('📦 Using database:', db.databaseName);
  console.log('Transactions collection:', transactionsCollection.collectionName);
}).catch((err) => {
  console.error('MongoDB connection failed:', err);
});

const USER = { email: 'maliabhi123@gmail.com', password: 'maliabhi123' };

app.post('/api/login', (req: Request, res: Response) => {
  const { email, password } = req.body;
  console.log("Login attempt with email:", email);
  if (email === USER.email && password === USER.password) {
    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
  } else {
    res.status(401).json({ message: 'Invalid credentials' });
  }
});

// logout route
app.post('/api/logout', (req: Request, res: Response) => {
  res.json({ message: 'Logout successful' });
});


interface AuthenticatedRequest extends Request {
  user?: string | JwtPayload;
}

function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    res.sendStatus(401);
    return;
  }
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      res.sendStatus(403);
      return;
    }
    req.user = user;
    next();
  });
}

app.get('/api/transactions', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const transactions = await transactionsCollection.find().toArray();
    console.log("Fetched transactions from MongoDB:", transactions.length);
    res.json(transactions);
  } catch (error) {
    console.error("Error fetching transactions:", error);
    res.status(500).json({ message: 'Failed to fetch transactions from DB' });
  }
});



// 3. Get unique filter values for dropdowns
app.get('/api/filters', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const categories = await transactionsCollection.distinct('category');
    const statuses = await transactionsCollection.distinct('status');
    const users = await transactionsCollection.distinct('user');

    res.json({
      categories: categories.sort(),
      statuses: statuses.sort(),
      users: users.sort()
    });
  } catch (error) {
    console.error("Error fetching filter options:", error);
    res.status(500).json({ message: 'Failed to fetch filter options' });
  }
});



// 4. CSV Export route
app.post('/api/export/csv', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { 
      columns = ['id', 'user', 'amount', 'category', 'status', 'date'],
      filters = {} 
    } = req.body;

    // Build MongoDB filter from provided filters
    const filter: any = {};

    if (filters.search) {
      filter.$or = [
        { user: { $regex: filters.search, $options: 'i' } },
        { category: { $regex: filters.search, $options: 'i' } },
        { status: { $regex: filters.search, $options: 'i' } },
        { id: { $regex: filters.search, $options: 'i' } }
      ];
    }

    if (filters.category) {
      filter.category = { $regex: filters.category, $options: 'i' };
    }

    if (filters.status) {
      filter.status = { $regex: filters.status, $options: 'i' };
    }

    if (filters.user) {
      filter.user = { $regex: filters.user, $options: 'i' };
    }

    if (filters.dateFrom || filters.dateTo) {
      filter.date = {};
      if (filters.dateFrom) {
        filter.date.$gte = filters.dateFrom;
      }
      if (filters.dateTo) {
        filter.date.$lte = filters.dateTo;
      }
    }

    if (filters.amountFrom || filters.amountTo) {
      filter.amount = {};
      if (filters.amountFrom) {
        filter.amount.$gte = parseFloat(filters.amountFrom);
      }
      if (filters.amountTo) {
        filter.amount.$lte = parseFloat(filters.amountTo);
      }
    }

    // Fetch filtered transactions
    const transactions = await transactionsCollection.find(filter).toArray();

    // Generate CSV
    const csvHeader = columns.join(',');
    const csvRows = transactions.map((txn: any) =>
      columns.map((col: string) => {
        const value = txn[col];
        // Wrap values in quotes if they contain commas
        return typeof value === 'string' && value.includes(',') 
          ? `"${value}"`
          : value;
      }).join(',')
    );

    const csvContent = [csvHeader, ...csvRows].join('\n');

    // Set headers for CSV download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=transactions_${Date.now()}.csv`);
    res.send(csvContent);
  } catch (error) {
    console.error("Error generating CSV:", error);
    res.status(500).json({ message: 'Failed to generate CSV export' });
  }
});

// GET /api/dashboard/analytics – Revenue, Expenses, Trends
app.get('/api/dashboard/analytics', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const transactions = await transactionsCollection.find().toArray();

    // Total revenue = category === "Revenue"
    const revenue = transactions
      .filter((t: any) => t.category === 'Revenue')
      .reduce((sum: number, t: any) => sum + t.amount, 0);

    // Total expenses = category !== "Revenue"
    const expenses = transactions
      .filter((t: any) => t.category !== 'Revenue')
      .reduce((sum: number, t: any) => sum + t.amount, 0);

    // Category-wise total amounts
    const categoryBreakdown = transactions.reduce((acc: any, t: any) => {
      acc[t.category] = (acc[t.category] || 0) + t.amount;
      return acc;
    }, {});

    // Status-wise counts
    const statusBreakdown = transactions.reduce((acc: any, t: any) => {
      acc[t.status] = (acc[t.status] || 0) + 1;
      return acc;
    }, {});


    // Monthly revenue and expense trends
    const monthlyTrends = transactions.reduce((acc: any, t: any) => {
      const month = t.date.substring(0, 7); // Format: YYYY-MM
      if (!acc[month]) {
        acc[month] = { revenue: 0, expenses: 0 };
      }
      if (t.category === 'Revenue') {
        acc[month].revenue += t.amount;
      } else {
        acc[month].expenses += t.amount;
      }
      return acc;
    }, {});

    res.json({
      summary: {
        totalRevenue: revenue,
        totalExpenses: expenses,
        netProfit: revenue - expenses,
        totalTransactions: transactions.length
      },
      categoryBreakdown,
      statusBreakdown,
      monthlyTrends
    });

  } catch (error) {
    console.error("Error fetching analytics:", error);
    res.status(500).json({ message: 'Failed to fetch analytics data' });
  }
});


app.get('/api/transactions/:id', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const transaction = await transactionsCollection.findOne({ id: parseInt(id) });

    if (!transaction) {
      res.status(404).json({ message: 'Transaction not found' });
      return;
    }

    res.json(transaction);
  } catch (error) {
    console.error("Error fetching transaction:", error);
    res.status(500).json({ message: 'Failed to fetch transaction' });
  }
});

//update the them 
app.put('/api/transactions/:id', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    delete updateData.id;

    const result = await transactionsCollection.updateOne(
      { id: Number(id) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      res.status(404).json({ message: 'Transaction not found' });
      return;
    }

    const updated = await transactionsCollection.findOne({ id: Number(id) });
    res.json(updated);
  } catch (error) {
    console.error("Error updating transaction:", error);
    res.status(500).json({ message: 'Failed to update transaction' });
  }
});


app.delete('/api/transactions/:id', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    const result = await transactionsCollection.deleteOne({ id: Number(id) });

    if (result.deletedCount === 0) {
      res.status(404).json({ message: 'Transaction not found' });
      return;
    }

    res.json({ message: 'Transaction deleted successfully' });
  } catch (error) {
    console.error("Error deleting transaction:", error);
    res.status(500).json({ message: 'Failed to delete transaction' });
  }
});



const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));


