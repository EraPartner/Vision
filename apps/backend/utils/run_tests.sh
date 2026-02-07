# Test runner script for Financial Transaction Manager API
# This script provides various test execution options with proper environment setup

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🧪 Financial Transaction Manager API Test Runner${NC}"
echo "================================================="

# Change to project root directory (since script is now in utils/)
cd "$(dirname "$0")/.." || exit 1

# Check if virtual environment is activated
if [[ "$VIRTUAL_ENV" == "" ]]; then
    echo -e "${YELLOW}⚠️  Warning: Virtual environment not detected${NC}"
    echo "Consider activating your virtual environment first"
fi

# Install test dependencies if needed
echo -e "${YELLOW}📦 Installing test dependencies...${NC}"
pip install -q -r config/requirements.txt

# Function to run tests with coverage
run_tests_with_coverage() {
    echo -e "${GREEN}🔬 Running tests with coverage...${NC}"
    pytest -c config/pytest.ini --cov=. --cov-report=html --cov-report=term-missing --cov-report=xml tests/ -v
}

# Function to run specific test categories
run_unit_tests() {
    echo -e "${GREEN}🔬 Running unit tests only...${NC}"
    pytest -c config/pytest.ini tests/ -v -m "not integration"
}

run_admin_tests() {
    echo -e "${GREEN}🔬 Running admin endpoint tests...${NC}"
    pytest -c config/pytest.ini tests/test_admin.py -v
}

run_category_tests() {
    echo -e "${GREEN}🔬 Running category endpoint tests...${NC}"
    pytest -c config/pytest.ini tests/test_categories.py -v
}

run_main_tests() {
    echo -e "${GREEN}🔬 Running main application tests...${NC}"
    pytest -c config/pytest.ini tests/test_main.py -v
}

# Function to run all tests
run_all_tests() {
    echo -e "${GREEN}🔬 Running all tests...${NC}"
    pytest -c config/pytest.ini tests/ -v
}

# Parse command line arguments
case "${1:-all}" in
    "all")
        run_all_tests
        ;;
    "coverage")
        run_tests_with_coverage
        ;;
    "unit")
        run_unit_tests
        ;;
    "admin")
        run_admin_tests
        ;;
    "categories")
        run_category_tests
        ;;
    "main")
        run_main_tests
        ;;
    "help"|"-h"|"--help")
        echo "Usage: $0 [option]"
        echo ""
        echo "Options:"
        echo "  all        Run all tests (default)"
        echo "  coverage   Run tests with coverage report"
        echo "  unit       Run unit tests only"
        echo "  admin      Run admin endpoint tests"
        echo "  categories Run category endpoint tests"
        echo "  main       Run main application tests"
        echo "  help       Show this help message"
        ;;
    *)
        echo -e "${RED}❌ Unknown option: $1${NC}"
        echo "Use '$0 help' for available options"
        exit 1
        ;;
esac

echo -e "${GREEN}✅ Test execution completed${NC}"